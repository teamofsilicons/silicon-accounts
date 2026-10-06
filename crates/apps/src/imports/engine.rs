//! Processing an import job: chunks of [`CHUNK_ROWS`] rows, one transaction per chunk.
//!
//! For each chunk:
//! 1. per-row rules ([`super::rules::prepare`]);
//! 2. duplicates inside the file (any email/phone seen in an earlier row → `skipped
//!    duplicate_in_file`);
//! 3. one query finds the accounts owning the chunk's emails and phones: two accounts →
//!    `error ambiguous_match`, one → match, none → create;
//! 4. memberships of matched accounts and owners of the chunk's external ids
//!    (`error external_id_conflict`); an account that removed this app's access is not added
//!    back (`skipped access_removed`); a member's external_id only changes with
//!    `update_existing` (else `warning external_id_differs`);
//! 5. ids for new accounts, checked in batches (`id_conflict` / `invalid_username` /
//!    `reserved_username` warnings say what was wanted and what was assigned);
//! 6. writes (not in dry runs) in bulk inside a savepoint: accounts (`unclaimed`, carrying only
//!    the row's primary email or phone, unverified), handle history, memberships (`imported`,
//!    source `import`, external_id, imported_profile = the cleaned row with every email and
//!    phone);
//! 7. the row outcomes and the job counters, committed with the writes.
//!
//! Why a new account carries one address: whoever proves an address on an unclaimed account
//! finishes it and becomes its owner, and an address on an account belongs to that account.
//! If a row could put several addresses on one account, an app could bundle a stranger's email
//! with one it controls, claim the account with its own, and the stranger's later sign-in would
//! land in that account (or the reverse). With one address, the Carbon who proves it is the
//! only one who can claim it; the other addresses stay in the app's imported data
//! (`info identifiers_not_attached`) until their owner adds and verifies them.
//!
//! If a bulk write hits a uniqueness race (someone signed up with the same email, or took the
//! same id, between the checks and the insert), the savepoint is rolled back and the chunk is
//! redone one row at a time with fresh checks. Nothing here ever sends an email or SMS.

use std::collections::{BTreeMap, HashMap};

use accounts_core::ids::{AccountId, handle_base, uuid_for_number, validate_handle, with_suffix};
use accounts_core::models::AccountKind;
use accounts_core::repo::is_unique_violation;
use accounts_core::{ApiError, ApiResult, normalize};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Connection, PgConnection};
use time::Date;
use uuid::Uuid;

use super::input::ImportOptions;
use super::rules::{self, Level, Prepared, RowMessage, Username, codes, prepare};

/// Rows per chunk (and per transaction).
pub const CHUNK_ROWS: i64 = 500;

/// Outcome of one row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Pending,
    Created,
    Matched,
    Updated,
    Skipped,
    Error,
}

impl Outcome {
    pub fn as_str(&self) -> &'static str {
        match self {
            Outcome::Pending => "pending",
            Outcome::Created => "created",
            Outcome::Matched => "matched",
            Outcome::Updated => "updated",
            Outcome::Skipped => "skipped",
            Outcome::Error => "error",
        }
    }

    pub fn parse(s: &str) -> Option<Outcome> {
        Some(match s {
            "pending" => Outcome::Pending,
            "created" => Outcome::Created,
            "matched" => Outcome::Matched,
            "updated" => Outcome::Updated,
            "skipped" => Outcome::Skipped,
            "error" => Outcome::Error,
            _ => return None,
        })
    }
}

/// Per-outcome counters of a job (`import_jobs.counts`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Counts {
    pub created: i64,
    pub matched: i64,
    pub updated: i64,
    pub skipped: i64,
    pub error: i64,
    /// Warning messages over all rows.
    pub warnings: i64,
}

impl Counts {
    pub fn from_value(v: &Value) -> Counts {
        serde_json::from_value(v.clone()).unwrap_or_default()
    }

    pub fn add(&mut self, outcome: Outcome, warnings: i64) {
        match outcome {
            Outcome::Created => self.created += 1,
            Outcome::Matched => self.matched += 1,
            Outcome::Updated => self.updated += 1,
            Outcome::Skipped => self.skipped += 1,
            Outcome::Error => self.error += 1,
            Outcome::Pending => {}
        }
        self.warnings += warnings;
    }
}

/// The result of one row.
#[derive(Debug, Clone)]
pub struct RowResult {
    pub row_number: i32,
    pub outcome: Outcome,
    pub account_uuid: Option<String>,
    /// The id the row's account has (created: assigned; matched: the account's id).
    pub result_id: Option<String>,
    pub messages: Vec<RowMessage>,
}

impl RowResult {
    fn finished(row_number: i32, outcome: Outcome, messages: Vec<RowMessage>) -> RowResult {
        RowResult {
            row_number,
            outcome,
            account_uuid: None,
            result_id: None,
            messages,
        }
    }

    fn warnings(&self) -> i64 {
        self.messages
            .iter()
            .filter(|m| m.level == Level::Warning)
            .count() as i64
    }
}

/// What the rows of a job have claimed so far (identifiers, external ids, accounts, ids). Rows
/// are processed in order, so an earlier row always wins.
#[derive(Debug, Clone, Default)]
pub struct Claims {
    /// `email:x` / `phone:+1…` → first row with it.
    seen: HashMap<String, i32>,
    /// external_id → (row, account uuid when known).
    external_ids: HashMap<String, (i32, Option<String>)>,
    /// account uuid → row that imported it.
    accounts: HashMap<String, i32>,
    /// full id (`c:x`) → row that got it.
    handles: HashMap<String, i32>,
}

impl Claims {
    fn absorb(&mut self, other: Claims) {
        for (k, v) in other.seen {
            self.seen.entry(k).or_insert(v);
        }
        for (k, v) in other.external_ids {
            self.external_ids.entry(k).or_insert(v);
        }
        for (k, v) in other.accounts {
            self.accounts.entry(k).or_insert(v);
        }
        for (k, v) in other.handles {
            self.handles.entry(k).or_insert(v);
        }
    }
}

/// Claims visible while processing rows: the job's, the chunk's so far, and new ones.
struct Scope<'a> {
    job: &'a Claims,
    chunk: &'a Claims,
    local: Claims,
}

impl Scope<'_> {
    fn layers(&self) -> [&Claims; 3] {
        [&self.local, self.chunk, self.job]
    }
    fn seen(&self, k: &str) -> Option<i32> {
        self.layers().iter().find_map(|c| c.seen.get(k).copied())
    }
    fn see(&mut self, k: &str, row: i32) {
        if self.seen(k).is_none() {
            self.local.seen.insert(k.to_string(), row);
        }
    }
    fn external_id(&self, k: &str) -> Option<(i32, Option<String>)> {
        self.layers()
            .iter()
            .find_map(|c| c.external_ids.get(k).cloned())
    }
    fn account(&self, uuid: &str) -> Option<i32> {
        self.layers()
            .iter()
            .find_map(|c| c.accounts.get(uuid).copied())
    }
    fn handle(&self, full: &str) -> Option<i32> {
        self.layers()
            .iter()
            .find_map(|c| c.handles.get(full).copied())
    }
}

/// Everything a job needs to process rows.
#[derive(Debug, Clone)]
pub struct JobCtx {
    pub job_id: Uuid,
    pub app_id: String,
    pub options: ImportOptions,
    pub today: Date,
    pub iris_base_url: String,
}

/// Why processing rows stopped.
#[derive(Debug)]
pub enum ProcessError {
    /// A uniqueness race during the bulk write; redo with fresh checks.
    Conflict,
    Api(ApiError),
}

impl From<ApiError> for ProcessError {
    fn from(e: ApiError) -> Self {
        ProcessError::Api(e)
    }
}

impl From<sqlx::Error> for ProcessError {
    fn from(e: sqlx::Error) -> Self {
        // A deadlock (two imports inserting the same new emails in different orders) is a
        // race like a uniqueness clash: redo the rows one at a time with fresh checks.
        let deadlock =
            matches!(&e, sqlx::Error::Database(db) if db.code().as_deref() == Some("40P01"));
        if deadlock || is_unique_violation(&e, None) {
            ProcessError::Conflict
        } else {
            ProcessError::Api(e.into())
        }
    }
}

/// A row that will become a new account.
#[derive(Debug, Clone)]
struct Create {
    idx: usize,
    handle: Option<AccountId>,
    uuid: Option<String>,
}

/// A row matched to an existing account.
#[derive(Debug, Clone)]
struct Match {
    idx: usize,
    uuid: String,
    handle: Option<String>,
    membership_existed: bool,
}

/// A matched account's membership with the app, when it has one.
#[derive(Debug, Clone, sqlx::FromRow)]
struct Member {
    account_uuid: String,
    status: String,
    external_id: Option<String>,
}

#[derive(Debug, Clone)]
struct Owner {
    uuid: String,
    handle: Option<String>,
}

fn lowercase_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_lowercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn describe_key(k: &str) -> String {
    match k.split_once(':') {
        Some(("email", v)) => format!("the email {v}"),
        Some(("phone", v)) => format!("the phone number {v}"),
        _ => k.to_string(),
    }
}

/// Decides (and, unless dry run, writes) a set of rows. Returns their results and the claims
/// they made; nothing in `job`/`chunk` changes, so a caller can discard both on failure.
pub async fn process_rows(
    conn: &mut PgConnection,
    ctx: &JobCtx,
    job: &Claims,
    chunk: &Claims,
    rows: &[(i32, Prepared)],
) -> Result<(Vec<RowResult>, Claims), ProcessError> {
    let mut scope = Scope {
        job,
        chunk,
        local: Claims::default(),
    };
    let mut results: Vec<Option<RowResult>> = vec![None; rows.len()];
    let mut messages: Vec<Vec<RowMessage>> = rows.iter().map(|(_, p)| p.messages.clone()).collect();

    // 1–2: unusable rows and duplicates inside the file.
    let mut candidates: Vec<usize> = Vec::new();
    for (i, (n, p)) in rows.iter().enumerate() {
        if p.fatal {
            results[i] = Some(RowResult::finished(
                *n,
                Outcome::Error,
                std::mem::take(&mut messages[i]),
            ));
            continue;
        }
        let keys = p.identifier_keys();
        let dup = keys
            .iter()
            .find_map(|k| scope.seen(k).map(|r| (k.clone(), r)));
        for k in &keys {
            scope.see(k, *n);
        }
        if let Some((k, first)) = dup {
            messages[i].push(RowMessage::info(
                codes::DUPLICATE_IN_FILE,
                format!(
                    "Row {n} repeats {} from row {first}, so it was skipped; only row {first} was imported.",
                    describe_key(&k)
                ),
                None,
            ));
            results[i] = Some(RowResult::finished(
                *n,
                Outcome::Skipped,
                std::mem::take(&mut messages[i]),
            ));
            continue;
        }
        candidates.push(i);
    }

    // 3: who owns these emails and phones.
    let mut emails: Vec<String> = Vec::new();
    let mut phones: Vec<String> = Vec::new();
    for &i in &candidates {
        emails.extend(rows[i].1.emails.iter().cloned());
        phones.extend(rows[i].1.phones.iter().cloned());
    }
    let mut owners: HashMap<String, Owner> = HashMap::new();
    if !emails.is_empty() {
        let found: Vec<(String, String, Option<String>)> = sqlx::query_as(
            "select e.email, a.uuid, a.handle from account_emails e join accounts a on a.uuid = e.account_uuid \
             where e.email = any($1)",
        )
        .bind(&emails)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::from)?;
        for (e, uuid, handle) in found {
            owners.insert(format!("email:{e}"), Owner { uuid, handle });
        }
    }
    if !phones.is_empty() {
        let found: Vec<(String, String, Option<String>)> = sqlx::query_as(
            "select p.phone, a.uuid, a.handle from account_phones p join accounts a on a.uuid = p.account_uuid \
             where p.phone = any($1)",
        )
        .bind(&phones)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::from)?;
        for (ph, uuid, handle) in found {
            owners.insert(format!("phone:{ph}"), Owner { uuid, handle });
        }
    }

    enum Plan {
        Create,
        Match(Owner),
    }
    let mut plans: Vec<(usize, Plan)> = Vec::new();
    for &i in &candidates {
        let (n, p) = &rows[i];
        let mut by_account: BTreeMap<String, (Owner, Vec<String>)> = BTreeMap::new();
        for k in p.identifier_keys() {
            if let Some(o) = owners.get(&k) {
                by_account
                    .entry(o.uuid.clone())
                    .or_insert_with(|| (o.clone(), Vec::new()))
                    .1
                    .push(describe_key(&k));
            }
        }
        match by_account.len() {
            0 => plans.push((i, Plan::Create)),
            1 => {
                let owner = by_account.into_values().next().map(|(o, _)| o);
                if let Some(o) = owner {
                    plans.push((i, Plan::Match(o)));
                }
            }
            count => {
                // Which identifiers point where, without naming the accounts.
                let groups: Vec<String> = by_account
                    .into_values()
                    .enumerate()
                    .map(|(k, (_, keys))| format!("{} → account {}", keys.join(" and "), k + 1))
                    .collect();
                messages[i].push(RowMessage::error(
                    codes::AMBIGUOUS_MATCH,
                    format!(
                        "Row {n} can't be imported as one account: its identifiers belong to {count} different accounts ({}). Split it into one row per person, or remove the identifier that belongs to someone else.",
                        groups.join("; ")
                    ),
                    None,
                ));
                results[i] = Some(RowResult::finished(
                    *n,
                    Outcome::Error,
                    std::mem::take(&mut messages[i]),
                ));
            }
        }
    }

    // 4: memberships of matched accounts and owners of external ids.
    let matched_uuids: Vec<String> = plans
        .iter()
        .filter_map(|(_, p)| match p {
            Plan::Match(o) => Some(o.uuid.clone()),
            Plan::Create => None,
        })
        .collect();
    let mut memberships: HashMap<String, Member> = HashMap::new();
    if !matched_uuids.is_empty() {
        let found: Vec<Member> = sqlx::query_as(
            "select account_uuid, status, external_id from memberships where app_id = $1 and account_uuid = any($2)",
        )
        .bind(&ctx.app_id)
        .bind(&matched_uuids)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::from)?;
        memberships.extend(found.into_iter().map(|m| (m.account_uuid.clone(), m)));
    }
    let external_ids: Vec<String> = plans
        .iter()
        .filter_map(|(i, _)| rows[*i].1.external_id.clone())
        .collect();
    let mut ext_owners: HashMap<String, String> = HashMap::new();
    if !external_ids.is_empty() {
        let found: Vec<(String, String)> = sqlx::query_as(
            "select external_id, account_uuid from memberships where app_id = $1 and external_id = any($2)",
        )
        .bind(&ctx.app_id)
        .bind(&external_ids)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::from)?;
        ext_owners.extend(found);
    }

    let mut creates: Vec<Create> = Vec::new();
    let mut matches: Vec<Match> = Vec::new();
    for (i, plan) in plans {
        let (n, p) = &rows[i];
        let account = match &plan {
            Plan::Match(o) => Some(o.uuid.as_str()),
            Plan::Create => None,
        };
        if let Plan::Match(o) = &plan {
            if let Some(first) = scope.account(&o.uuid) {
                messages[i].push(RowMessage::info(
                    codes::DUPLICATE_IN_FILE,
                    format!(
                        "Row {n} matches the same account as row {first} (through another email or phone), so it was skipped; only row {first} was imported."
                    ),
                    None,
                ));
                results[i] = Some(RowResult::finished(
                    *n,
                    Outcome::Skipped,
                    std::mem::take(&mut messages[i]),
                ));
                continue;
            }
            if memberships.get(&o.uuid).map(|m| m.status.as_str()) == Some("access_removed") {
                messages[i].push(RowMessage::warning(
                    codes::ACCESS_REMOVED,
                    "This account removed the app's access, so an import doesn't add it back; it returns to the user base when it signs in to the app again.",
                    None,
                ));
                results[i] = Some(RowResult::finished(
                    *n,
                    Outcome::Skipped,
                    std::mem::take(&mut messages[i]),
                ));
                continue;
            }
        }
        if let Some(ext) = &p.external_id {
            let db_conflict = ext_owners
                .get(ext)
                .is_some_and(|owner| Some(owner.as_str()) != account);
            let file_conflict = scope.external_id(ext).and_then(|(first, acc)| {
                (account.is_none() || acc.as_deref() != account).then_some(first)
            });
            if db_conflict || file_conflict.is_some() {
                let why = match file_conflict {
                    Some(first) => format!("row {first} of this import already uses it"),
                    None => "another member of this app already has it".to_string(),
                };
                messages[i].push(RowMessage::error(
                    codes::EXTERNAL_ID_CONFLICT,
                    format!(
                        "external_id '{ext}' can't be used for row {n}: {why}. External ids are unique per app; fix the duplicate in your data."
                    ),
                    Some("external_id"),
                ));
                results[i] = Some(RowResult::finished(
                    *n,
                    Outcome::Error,
                    std::mem::take(&mut messages[i]),
                ));
                continue;
            }
            scope
                .local
                .external_ids
                .insert(ext.clone(), (*n, account.map(str::to_string)));
            // An existing member keeps the external_id the app gave it unless update_existing
            // says to replace it: a typo in a later export must not remap the app's links.
            if let Plan::Match(o) = &plan
                && !ctx.options.update_existing
                && let Some(current) = memberships
                    .get(&o.uuid)
                    .and_then(|m| m.external_id.as_deref())
                && current != ext
            {
                messages[i].push(RowMessage::warning(
                    codes::EXTERNAL_ID_DIFFERS,
                    format!(
                        "This account is already in the app's user base with external_id {}; the row says {}. Kept {} (import with update_existing=true to replace it).",
                        rules::quote(current),
                        rules::quote(ext),
                        rules::quote(current)
                    ),
                    Some("external_id"),
                ));
            }
        }
        match plan {
            Plan::Match(o) => {
                scope.local.accounts.insert(o.uuid.clone(), *n);
                matches.push(Match {
                    idx: i,
                    membership_existed: memberships.contains_key(&o.uuid),
                    uuid: o.uuid,
                    handle: o.handle,
                });
            }
            Plan::Create => creates.push(Create {
                idx: i,
                handle: None,
                uuid: None,
            }),
        }
    }

    // 5: ids for new accounts.
    allocate_handles(conn, rows, &mut creates, &mut messages, &mut scope).await?;
    let unassigned: Vec<usize> = creates
        .iter()
        .filter(|c| c.handle.is_none())
        .map(|c| c.idx)
        .collect();
    for i in unassigned {
        let n = rows[i].0;
        messages[i].push(RowMessage::error(
            codes::IMPORT_CONFLICT,
            "No free id could be found for this row; give it a distinct username and import it again.",
            Some("username"),
        ));
        results[i] = Some(RowResult::finished(
            n,
            Outcome::Error,
            std::mem::take(&mut messages[i]),
        ));
    }
    creates.retain(|c| c.handle.is_some());

    // 6: writes.
    if !ctx.options.dry_run && (!creates.is_empty() || !matches.is_empty()) {
        let mut sp = conn.begin().await.map_err(ApiError::from)?;
        match write(&mut sp, ctx, rows, &mut creates, &matches).await {
            Ok(()) => sp.commit().await.map_err(ApiError::from)?,
            Err(e) => {
                sp.rollback().await.map_err(ApiError::from)?;
                return Err(e);
            }
        }
    }

    for c in &creates {
        let (n, p) = &rows[c.idx];
        let others = p.other_identifiers();
        if let (Some(primary), false) = (p.primary_identifier(), others.is_empty()) {
            messages[c.idx].push(RowMessage::info(
                codes::IDENTIFIERS_NOT_ATTACHED,
                format!(
                    "The new account carries only {primary}: the Carbon proves it when they finish setting up the account, so only its owner can claim it. {} stay{} in this app's imported data until the Carbon adds and verifies {} themselves.",
                    others.join(", "),
                    if others.len() == 1 { "s" } else { "" },
                    if others.len() == 1 { "it" } else { "them" }
                ),
                None,
            ));
        }
        let n = *n;
        results[c.idx] = Some(RowResult {
            row_number: n,
            outcome: Outcome::Created,
            account_uuid: c.uuid.clone(),
            result_id: c.handle.as_ref().map(AccountId::to_string),
            messages: std::mem::take(&mut messages[c.idx]),
        });
    }
    for m in &matches {
        let n = rows[m.idx].0;
        let outcome = if m.membership_existed && ctx.options.update_existing {
            Outcome::Updated
        } else {
            Outcome::Matched
        };
        results[m.idx] = Some(RowResult {
            row_number: n,
            outcome,
            account_uuid: Some(m.uuid.clone()),
            result_id: m.handle.clone(),
            messages: std::mem::take(&mut messages[m.idx]),
        });
    }
    let out: Vec<RowResult> = results
        .into_iter()
        .enumerate()
        .map(|(i, r)| {
            r.unwrap_or_else(|| {
                // Every row reaches a result above; keep a precise answer if that ever breaks.
                RowResult::finished(
                    rows[i].0,
                    Outcome::Error,
                    vec![RowMessage::error(
                        codes::IMPORT_CONFLICT,
                        "This row could not be decided; import it again.",
                        None,
                    )],
                )
            })
        })
        .collect();
    Ok((out, scope.local))
}

/// Handles that exist or are reserved: full id → `taken` | `reserved`.
async fn taken_handles(
    conn: &mut PgConnection,
    fulls: &[String],
) -> ApiResult<HashMap<String, &'static str>> {
    if fulls.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, bool)> = sqlx::query_as(
        "select h, exists (select 1 from accounts a where a.handle = h) from unnest($1::text[]) as h \
         where exists (select 1 from accounts a where a.handle = h) \
            or exists (select 1 from handle_reservations r where r.handle = h and r.reserved_until > now())",
    )
    .bind(fulls)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(h, taken)| (h, if taken { "taken" } else { "reserved" }))
        .collect())
}

/// Candidate ids of one new account, in preference order, produced lazily — the order of
/// `accounts_core::ids::handle_candidates` (each distinct base, then the first base with -2 …
/// -20, then random 4-digit suffixes), extended with 6 random hex digits so it never runs out.
/// Lazy because a 100k-row import mostly needs one or two candidates per row.
struct Candidates {
    /// The username, when it is a valid handle.
    wish: Option<String>,
    /// Plain bases from the seeds (username, email local part, display name).
    bases: Vec<String>,
    next_base: usize,
    /// Base for numbered and random suffixes.
    first: String,
    numbered: u32,
    random: u32,
    /// Why the wish could not be used (taken / reserved / another row).
    wish_problem: Option<String>,
}

impl Candidates {
    fn for_row(p: &Prepared) -> Candidates {
        let (wish, bases, first) = match &p.username {
            Username::Valid(id) => {
                let h = id.handle().to_string();
                (Some(h.clone()), Vec::new(), h)
            }
            _ => {
                let mut bases: Vec<String> = Vec::new();
                for s in p.suggestion_seeds() {
                    if let Some(b) = handle_base(&s)
                        && !bases.contains(&b)
                    {
                        bases.push(b);
                    }
                }
                let first = bases
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "carbon".to_string());
                (None, bases, first)
            }
        };
        Candidates {
            wish,
            bases,
            next_base: 0,
            first,
            numbered: 2,
            random: 0,
            wish_problem: None,
        }
    }

    fn next_candidate(&mut self) -> String {
        for _ in 0..200 {
            let c = if self.next_base < self.bases.len() {
                self.next_base += 1;
                self.bases[self.next_base - 1].clone()
            } else if self.numbered <= 20 {
                self.numbered += 1;
                with_suffix(&self.first, &format!("-{}", self.numbered - 1))
            } else if self.random < 20 {
                self.random += 1;
                let n =
                    1000 + u16::from_le_bytes(accounts_core::crypto::random_bytes::<2>()) % 9000;
                with_suffix(&self.first, &format!("-{n}"))
            } else {
                with_suffix(
                    &self.first,
                    &format!(
                        "-{}",
                        hex::encode(accounts_core::crypto::random_bytes::<3>())
                    ),
                )
            };
            // Reserved or otherwise invalid candidates are skipped, as in handle_candidates.
            if validate_handle(&c).is_ok() {
                return c;
            }
        }
        format!(
            "carbon-{}",
            hex::encode(accounts_core::crypto::random_bytes::<4>())
        )
    }

    /// The next `k` candidate handles (without prefix).
    fn next(&mut self, k: usize, first_round: bool) -> Vec<String> {
        let mut out = Vec::with_capacity(k);
        if first_round && let Some(w) = &self.wish {
            out.push(w.clone());
        }
        while out.len() < k {
            out.push(self.next_candidate());
        }
        out
    }
}

async fn allocate_handles(
    conn: &mut PgConnection,
    rows: &[(i32, Prepared)],
    creates: &mut [Create],
    messages: &mut [Vec<RowMessage>],
    scope: &mut Scope<'_>,
) -> Result<(), ProcessError> {
    if creates.is_empty() {
        return Ok(());
    }
    let mut cands: Vec<Candidates> = creates
        .iter()
        .map(|c| Candidates::for_row(&rows[c.idx].1))
        .collect();
    let mut pending: Vec<usize> = (0..creates.len()).collect();
    for round in 0..40 {
        if pending.is_empty() {
            break;
        }
        let k = if round == 0 { 2 } else { 6 };
        let asked: Vec<(usize, Vec<String>)> = pending
            .iter()
            .map(|&c| (c, cands[c].next(k, round == 0)))
            .collect();
        let fulls: Vec<String> = asked
            .iter()
            .flat_map(|(_, hs)| hs.iter().map(|h| format!("c:{h}")))
            .collect();
        let taken = taken_handles(conn, &fulls).await?;
        for (c, hs) in asked {
            let row = rows[creates[c].idx].0;
            for h in hs {
                let full = format!("c:{h}");
                let is_wish = cands[c].wish.as_deref() == Some(h.as_str());
                // An earlier row of this import first: its account may already exist, but
                // "row N took it" is the more useful explanation.
                if let Some(other) = scope.handle(&full) {
                    if is_wish {
                        cands[c].wish_problem =
                            Some(format!("row {other} of this import already took {full}"));
                    }
                    continue;
                }
                if let Some(reason) = taken.get(&full) {
                    if is_wish {
                        cands[c].wish_problem = Some(match *reason {
                            "taken" => format!("{full} is already taken by another account"),
                            _ => format!(
                                "{full} was released recently and is reserved for its previous owner"
                            ),
                        });
                    }
                    continue;
                }
                let Ok(id) = AccountId::new(AccountKind::Carbon, &h) else {
                    continue;
                };
                scope.local.handles.insert(full, row);
                creates[c].handle = Some(id);
                break;
            }
        }
        pending.retain(|&c| creates[c].handle.is_none());
    }

    // Say what was wanted and what was assigned.
    for (c, create) in creates.iter().enumerate() {
        let Some(assigned) = &create.handle else {
            continue;
        };
        let p = &rows[create.idx].1;
        let raw = p.username_raw.as_deref().unwrap_or("");
        let msg = match &p.username {
            Username::Missing => None,
            Username::Valid(wanted) if wanted == assigned => None,
            Username::Valid(wanted) => Some(RowMessage::warning(
                codes::ID_CONFLICT,
                format!(
                    "Wanted {wanted}, assigned {assigned}: {}.",
                    cands[c]
                        .wish_problem
                        .clone()
                        .unwrap_or_else(|| format!("{wanted} is not available"))
                ),
                Some("username"),
            )),
            Username::Reserved => Some(RowMessage::warning(
                codes::RESERVED_USERNAME,
                format!(
                    "The username {} is a reserved word and can't be an id; assigned {assigned} instead.",
                    rules::quote(raw)
                ),
                Some("username"),
            )),
            Username::Invalid { why, .. } => Some(RowMessage::warning(
                codes::INVALID_USERNAME,
                format!(
                    "The username {} can't be an id: {}. Assigned {assigned} instead.",
                    rules::quote(raw),
                    lowercase_first(why.trim_end_matches('.'))
                ),
                Some("username"),
            )),
        };
        messages[create.idx].extend(msg);
    }
    Ok(())
}

/// Bulk writes for decided rows (inside the caller's savepoint).
async fn write(
    conn: &mut PgConnection,
    ctx: &JobCtx,
    rows: &[(i32, Prepared)],
    creates: &mut [Create],
    matches: &[Match],
) -> Result<(), ProcessError> {
    if !creates.is_empty() {
        let mut handles: Vec<String> = creates
            .iter()
            .filter_map(|c| c.handle.as_ref().map(AccountId::to_string))
            .collect();
        handles.sort();
        // The same per-id lock every id change takes, so nobody claims these ids meanwhile.
        sqlx::query(
            "select pg_advisory_xact_lock(hashtextextended('handle:' || h, 0)) from unnest($1::text[]) as h",
        )
        .bind(&handles)
        .execute(&mut *conn)
        .await?;
        if !taken_handles(conn, &handles).await?.is_empty() {
            return Err(ProcessError::Conflict);
        }
        let numbers: Vec<i64> = sqlx::query_scalar(
            "select nextval('account_number_seq') from generate_series(1, $1::int)",
        )
        .bind(creates.len() as i32)
        .fetch_all(&mut *conn)
        .await?;
        if numbers.len() != creates.len() {
            return Err(ApiError::internal("nextval returned the wrong number of rows").into());
        }
        let default_dob = normalize::default_dob(ctx.today);
        let mut a_uuid = Vec::with_capacity(creates.len());
        let mut a_number = Vec::with_capacity(creates.len());
        let mut a_handle = Vec::with_capacity(creates.len());
        let mut a_name = Vec::with_capacity(creates.len());
        let mut a_pfp = Vec::with_capacity(creates.len());
        let mut a_dob: Vec<Date> = Vec::with_capacity(creates.len());
        let mut a_tz = Vec::with_capacity(creates.len());
        let mut e_value = Vec::new();
        let mut e_owner = Vec::new();
        let mut e_primary = Vec::new();
        let mut p_value = Vec::new();
        let mut p_owner = Vec::new();
        let mut p_primary = Vec::new();
        let mut m_uuid = Vec::with_capacity(creates.len());
        let mut m_ext: Vec<Option<String>> = Vec::with_capacity(creates.len());
        let mut m_profile = Vec::with_capacity(creates.len());
        for (c, n) in creates.iter_mut().zip(numbers) {
            let p = &rows[c.idx].1;
            let uuid = uuid_for_number(n as u64);
            let handle = c
                .handle
                .as_ref()
                .map(AccountId::to_string)
                .unwrap_or_default();
            a_pfp.push(p.pfp_url.clone().unwrap_or_else(|| {
                accounts_core::pfp::default_pfp_url(&ctx.iris_base_url, AccountKind::Carbon, &uuid)
            }));
            a_uuid.push(uuid.clone());
            a_number.push(n);
            a_handle.push(handle);
            a_name.push(p.account_display_name());
            a_dob.push(p.dob.unwrap_or(default_dob));
            a_tz.push(p.timezone.clone().unwrap_or_else(|| "UTC".to_string()));
            // Only the primary email or phone goes on the account (see the module docs).
            if let Some(e) = p.emails.first() {
                e_value.push(e.clone());
                e_owner.push(uuid.clone());
                e_primary.push(true);
            } else if let Some(ph) = p.phones.first() {
                p_value.push(ph.clone());
                p_owner.push(uuid.clone());
                p_primary.push(true);
            }
            m_uuid.push(uuid.clone());
            m_ext.push(p.external_id.clone());
            m_profile.push(p.profile());
            c.uuid = Some(uuid);
        }
        sqlx::query(
            "insert into accounts (uuid, number, kind, handle, status, display_name, pfp_url, dob, timezone) \
             select u, n, 'carbon', h, 'unclaimed', d, p, b, t \
             from unnest($1::text[], $2::bigint[], $3::text[], $4::text[], $5::text[], $6::date[], $7::text[]) \
               as x(u, n, h, d, p, b, t)",
        )
        .bind(&a_uuid)
        .bind(&a_number)
        .bind(&a_handle)
        .bind(&a_name)
        .bind(&a_pfp)
        .bind(&a_dob)
        .bind(&a_tz)
        .execute(&mut *conn)
        .await?;
        if !e_value.is_empty() {
            sqlx::query(
                "insert into account_emails (email, account_uuid, is_primary) \
                 select * from unnest($1::text[], $2::text[], $3::bool[])",
            )
            .bind(&e_value)
            .bind(&e_owner)
            .bind(&e_primary)
            .execute(&mut *conn)
            .await?;
        }
        if !p_value.is_empty() {
            sqlx::query(
                "insert into account_phones (phone, account_uuid, is_primary) \
                 select * from unnest($1::text[], $2::text[], $3::bool[])",
            )
            .bind(&p_value)
            .bind(&p_owner)
            .bind(&p_primary)
            .execute(&mut *conn)
            .await?;
        }
        sqlx::query(
            "insert into handle_history (account_uuid, old_handle, new_handle, changed_by) \
             select u, null, h, 'import' from unnest($1::text[], $2::text[]) as x(u, h)",
        )
        .bind(&a_uuid)
        .bind(&a_handle)
        .execute(&mut *conn)
        .await?;
        sqlx::query(
            "insert into memberships (app_id, account_uuid, status, source, external_id, imported_profile) \
             select $1, u, 'imported', 'import', e, p from unnest($2::text[], $3::text[], $4::jsonb[]) as x(u, e, p)",
        )
        .bind(&ctx.app_id)
        .bind(&m_uuid)
        .bind(&m_ext)
        .bind(&m_profile)
        .execute(&mut *conn)
        .await?;
    }
    if !matches.is_empty() {
        let uuids: Vec<String> = matches.iter().map(|m| m.uuid.clone()).collect();
        let exts: Vec<Option<String>> = matches
            .iter()
            .map(|m| rows[m.idx].1.external_id.clone())
            .collect();
        let profiles: Vec<Value> = matches.iter().map(|m| rows[m.idx].1.profile()).collect();
        // A membership that already exists keeps its status (active stays active), its
        // external_id and its profile unless update_existing (empty ones are filled in); the
        // account's own data is never touched.
        sqlx::query(
            "insert into memberships (app_id, account_uuid, status, source, external_id, imported_profile) \
             select $1, u, 'imported', 'import', e, p from unnest($2::text[], $3::text[], $4::jsonb[]) as x(u, e, p) \
             on conflict (app_id, account_uuid) do update set \
               external_id = case when $5 then coalesce(excluded.external_id, memberships.external_id) \
                                  else coalesce(memberships.external_id, excluded.external_id) end, \
               imported_profile = case when $5 or memberships.imported_profile is null \
                                       then excluded.imported_profile else memberships.imported_profile end, \
               updated_at = now()",
        )
        .bind(&ctx.app_id)
        .bind(&uuids)
        .bind(&exts)
        .bind(&profiles)
        .bind(ctx.options.update_existing)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// Stores row results and the job counters (inside the chunk's transaction).
pub async fn store_results(
    conn: &mut PgConnection,
    job_id: Uuid,
    results: &[RowResult],
    counts: &Counts,
) -> ApiResult<()> {
    let mut n = Vec::with_capacity(results.len());
    let mut o = Vec::with_capacity(results.len());
    let mut u: Vec<Option<String>> = Vec::with_capacity(results.len());
    let mut m: Vec<Value> = Vec::with_capacity(results.len());
    let mut id: Vec<Option<String>> = Vec::with_capacity(results.len());
    for r in results {
        n.push(r.row_number);
        o.push(r.outcome.as_str());
        u.push(r.account_uuid.clone());
        m.push(serde_json::to_value(&r.messages)?);
        id.push(r.result_id.clone());
    }
    sqlx::query(
        "update import_job_rows r set outcome = x.o, account_uuid = x.u, messages = x.m, \
           input = case when x.id is null then r.input else jsonb_set(r.input, '{id}', to_jsonb(x.id)) end \
         from unnest($2::int[], $3::text[], $4::text[], $5::jsonb[], $6::text[]) as x(n, o, u, m, id) \
         where r.job_id = $1 and r.row_number = x.n",
    )
    .bind(job_id)
    .bind(&n)
    .bind(&o)
    .bind(&u)
    .bind(&m)
    .bind(&id)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "update import_jobs set processed_rows = processed_rows + $2, counts = $3 where id = $1",
    )
    .bind(job_id)
    .bind(results.len() as i32)
    .bind(serde_json::to_value(counts)?)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// The state of a job after its processed rows (a fresh job: empty). Lets a job resume after a
/// crash with the same duplicate / external id / id decisions it would have made.
pub struct JobState {
    pub claims: Claims,
    pub counts: Counts,
    /// Highest processed row number (rows are processed in order).
    pub last_row: i32,
}

pub async fn rebuild_state(conn: &mut PgConnection, ctx: &JobCtx) -> ApiResult<JobState> {
    let processed: Vec<(i32, Value, String, Option<String>, Value)> = sqlx::query_as(
        "select row_number, input, outcome, account_uuid, messages from import_job_rows \
         where job_id = $1 and outcome <> 'pending' order by row_number",
    )
    .bind(ctx.job_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut st = JobState {
        claims: Claims::default(),
        counts: Counts::default(),
        last_row: 0,
    };
    for (n, input, outcome, account, msgs) in processed {
        let outcome = Outcome::parse(&outcome).unwrap_or(Outcome::Error);
        let msgs: Vec<RowMessage> = serde_json::from_value(msgs).unwrap_or_default();
        let warnings = msgs.iter().filter(|m| m.level == Level::Warning).count() as i64;
        st.counts.add(outcome, warnings);
        st.last_row = st.last_row.max(n);
        let p = prepare(&input, &ctx.options, ctx.today);
        if p.fatal {
            continue;
        }
        for k in p.identifier_keys() {
            st.claims.seen.entry(k).or_insert(n);
        }
        if matches!(
            outcome,
            Outcome::Created | Outcome::Matched | Outcome::Updated
        ) {
            if let Some(u) = &account {
                st.claims.accounts.entry(u.clone()).or_insert(n);
            }
            if let Some(ext) = p.external_id {
                st.claims
                    .external_ids
                    .entry(ext)
                    .or_insert((n, account.clone()));
            }
            if outcome == Outcome::Created
                && let Some(h) = input.get("id").and_then(Value::as_str)
            {
                st.claims.handles.entry(h.to_string()).or_insert(n);
            }
        }
    }
    Ok(st)
}

/// Processes one chunk: decide + write in one transaction (row by row on a uniqueness race),
/// store results, commit; only then the job state advances.
pub async fn process_chunk(
    conn: &mut PgConnection,
    ctx: &JobCtx,
    st: &mut JobState,
    chunk: &[(i32, Value)],
) -> ApiResult<()> {
    let prepared: Vec<(i32, Prepared)> = chunk
        .iter()
        .map(|(n, v)| (*n, prepare(v, &ctx.options, ctx.today)))
        .collect();
    let mut tx = conn.begin().await?;
    let empty = Claims::default();
    let (results, chunk_claims) = match process_rows(&mut tx, ctx, &st.claims, &empty, &prepared)
        .await
    {
        Ok(done) => done,
        Err(ProcessError::Api(e)) => return Err(e),
        Err(ProcessError::Conflict) => {
            let mut acc = Claims::default();
            let mut out = Vec::with_capacity(prepared.len());
            for row in &prepared {
                let mut attempt = 0;
                loop {
                    match process_rows(&mut tx, ctx, &st.claims, &acc, std::slice::from_ref(row))
                        .await
                    {
                        Ok((mut r, local)) => {
                            acc.absorb(local);
                            out.append(&mut r);
                            break;
                        }
                        Err(ProcessError::Api(e)) => return Err(e),
                        Err(ProcessError::Conflict) if attempt < 3 => attempt += 1,
                        Err(ProcessError::Conflict) => {
                            let mut msgs = row.1.messages.clone();
                            msgs.push(RowMessage::error(
                                codes::IMPORT_CONFLICT,
                                "Another change claimed this row's email, phone or id at the same moment, four times in a row; import this row again.",
                                None,
                            ));
                            out.push(RowResult::finished(row.0, Outcome::Error, msgs));
                            break;
                        }
                    }
                }
            }
            (out, acc)
        }
    };
    let mut counts = st.counts;
    for r in &results {
        counts.add(r.outcome, r.warnings());
    }
    store_results(&mut tx, ctx.job_id, &results, &counts).await?;
    tx.commit().await?;
    st.claims.absorb(chunk_claims);
    st.counts = counts;
    if let Some(last) = chunk.last() {
        st.last_row = st.last_row.max(last.0);
    }
    Ok(())
}

/// A JSON summary of a job's options and counts for audit records.
pub fn summary(ctx: &JobCtx, counts: &Counts) -> Value {
    json!({"job_id": ctx.job_id, "dry_run": ctx.options.dry_run, "counts": counts})
}
