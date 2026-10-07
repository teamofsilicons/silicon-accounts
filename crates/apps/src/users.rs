//! The app's user base (app or owner):
//!
//! - `GET /v1/apps/{app_id}/users?limit&cursor&q&status&kind&source`
//! - `GET /v1/apps/{app_id}/users/{uuid}` (+ the last 20 sign-ins at this app)
//!
//! Contact fields follow what the app may see: for an `active` membership the account's primary
//! email/phone, dob and timezone only within the granted scopes (Silicons never have email or
//! phone); for an `imported` membership the values the app itself supplied in the import; for an
//! `access_removed` membership none. Search (`q`) only looks at data the app may see, so it can't
//! be used to probe contact details it was never given.
//!
//! An account that removed the app's access stays in the list as history, and the app sees none
//! of the account's own data any more (the rule app webhook deliveries follow too: an app that
//! lost access to an account no longer sees its data): `display_name: "Access removed"`, the
//! default photo, no email, phone, dob or timezone, whatever the account changes afterwards. What
//! stays is who it is about (uuid, membership id, and the current `id`, which any uuid resolves
//! to through `GET /v1/accounts/{uuid}`), the app's own records (external_id, source, the scopes
//! it had been granted, its sign-ins and dates) and the account's status. Search finds them by
//! uuid, id, external_id or the app's own imported values, never by name. Signing in to the app
//! again makes the membership `active`, and everything it grants is shown again.
//!
//! A deleted account stays in the list as history with `status: "deleted"` (whatever its
//! membership said) and nothing about it but its uuid, membership id, external_id and dates: no
//! name, photo, id, email, phone, dob or timezone. `?status=deleted` lists only those; the other
//! status filters leave them out. Search finds them only by uuid or external_id.

use accounts_core::http::pagination::paginate;
use accounts_core::http::{AppOrOwner, Path, Query};
use accounts_core::models::{
    AccountKind, AccountStatus, MembershipSource, MembershipStatus, Scope, scopes_from_strings,
};
use accounts_core::pfp;
use accounts_core::{ApiError, ApiResult, AppState};
use axum::Router;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::{Date, OffsetDateTime};

use crate::util::{from_micros, like_contains, micros, parse_choice};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/apps/{app_id}/users", get(list_users))
        .route("/v1/apps/{app_id}/users/{uuid}", get(get_user))
}

#[derive(Debug, Default, Deserialize)]
struct UsersQuery {
    limit: Option<i64>,
    cursor: Option<String>,
    q: Option<String>,
    status: Option<String>,
    kind: Option<String>,
    source: Option<String>,
}

/// A membership joined with its account (one user-base row).
#[derive(Debug, Clone, sqlx::FromRow)]
struct UserRow {
    account_uuid: String,
    membership_id: String,
    status: MembershipStatus,
    source: MembershipSource,
    granted_scopes: Vec<String>,
    external_id: Option<String>,
    imported_profile: Option<Value>,
    first_signed_in_at: Option<OffsetDateTime>,
    last_signed_in_at: Option<OffsetDateTime>,
    created_at: OffsetDateTime,
    kind: AccountKind,
    handle: Option<String>,
    display_name: String,
    pfp_url: String,
    dob: Date,
    timezone: String,
    account_status: AccountStatus,
    primary_email: Option<String>,
    primary_phone: Option<String>,
}

const USER_SELECT: &str = "select m.account_uuid, m.membership_id, m.status, m.source, m.granted_scopes, \
     m.external_id, m.imported_profile, m.first_signed_in_at, m.last_signed_in_at, m.created_at, \
     a.kind, a.handle, a.display_name, a.pfp_url, a.dob, a.timezone, a.status as account_status, \
     (select e.email from account_emails e where e.account_uuid = a.uuid and e.is_primary) as primary_email, \
     (select p.phone from account_phones p where p.account_uuid = a.uuid and p.is_primary) as primary_phone \
     from memberships m join accounts a on a.uuid = m.account_uuid ";

/// Where a member stands with the app: its membership status, or `deleted` once the account
/// was deleted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UserStatus {
    Active,
    Imported,
    AccessRemoved,
    Deleted,
}

impl UserStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            UserStatus::Active => "active",
            UserStatus::Imported => "imported",
            UserStatus::AccessRemoved => "access_removed",
            UserStatus::Deleted => "deleted",
        }
    }

    pub fn parse(s: &str) -> Option<UserStatus> {
        Some(match s {
            "active" => UserStatus::Active,
            "imported" => UserStatus::Imported,
            "access_removed" => UserStatus::AccessRemoved,
            "deleted" => UserStatus::Deleted,
            _ => return None,
        })
    }
}

/// What a deleted account shows instead of its display name.
pub const DELETED_DISPLAY_NAME: &str = "Deleted account";

/// What an account that removed the app's access shows instead of its display name.
pub const ACCESS_REMOVED_DISPLAY_NAME: &str = "Access removed";

/// One item of the user base.
#[derive(Debug, Clone, Serialize)]
pub struct AppUserView {
    pub membership_id: String,
    pub uuid: String,
    pub kind: AccountKind,
    pub id: Option<String>,
    pub display_name: String,
    pub pfp_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dob: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    pub status: UserStatus,
    pub source: MembershipSource,
    pub external_id: Option<String>,
    pub granted_scopes: Vec<Scope>,
    #[serde(with = "accounts_core::timefmt::rfc3339_ms_option")]
    pub first_signed_in_at: Option<OffsetDateTime>,
    #[serde(with = "accounts_core::timefmt::rfc3339_ms_option")]
    pub last_signed_in_at: Option<OffsetDateTime>,
    #[serde(with = "accounts_core::timefmt::rfc3339_ms")]
    pub created_at: OffsetDateTime,
    /// The account's own state (`active`, `unclaimed` for an imported Carbon that hasn't signed
    /// in yet, `deleted`, …).
    pub account_status: AccountStatus,
}

fn first_string(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::Array(items) => items.iter().find_map(|i| i.as_str().map(str::to_string)),
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

impl UserRow {
    fn view(self, iris_base_url: &str) -> AppUserView {
        let scopes = scopes_from_strings(&self.granted_scopes);
        let withheld = if self.account_status == AccountStatus::Deleted {
            // History only: nothing about a deleted account is shown any more.
            Some((UserStatus::Deleted, DELETED_DISPLAY_NAME))
        } else if self.status == MembershipStatus::AccessRemoved {
            // The account took the app's access away: none of its data, then or after it
            // changes it.
            Some((UserStatus::AccessRemoved, ACCESS_REMOVED_DISPLAY_NAME))
        } else {
            None
        };
        if let Some((status, display_name)) = withheld {
            return AppUserView {
                pfp_url: pfp::default_pfp_url(iris_base_url, self.kind, &self.account_uuid),
                membership_id: self.membership_id,
                uuid: self.account_uuid,
                kind: self.kind,
                // A deleted account has no id any more. One that removed the app's access keeps
                // its public id: any uuid resolves to its current id (GET /v1/accounts/{uuid}).
                id: match status {
                    UserStatus::Deleted => None,
                    _ => self.handle,
                },
                display_name: display_name.to_string(),
                email: None,
                phone: None,
                dob: None,
                timezone: None,
                status,
                source: self.source,
                external_id: self.external_id,
                granted_scopes: scopes,
                first_signed_in_at: self.first_signed_in_at,
                last_signed_in_at: self.last_signed_in_at,
                created_at: self.created_at,
                account_status: self.account_status,
            };
        }
        let carbon = self.kind == AccountKind::Carbon;
        let (email, phone, dob, timezone) = match self.status {
            MembershipStatus::Active => (
                self.primary_email
                    .filter(|_| carbon && scopes.contains(&Scope::Email)),
                self.primary_phone
                    .filter(|_| carbon && scopes.contains(&Scope::Phone)),
                scopes
                    .contains(&Scope::Dob)
                    .then(|| accounts_core::timefmt::format_date(self.dob)),
                scopes
                    .contains(&Scope::Timezone)
                    .then(|| self.timezone.clone()),
            ),
            MembershipStatus::Imported => {
                let p = self.imported_profile.as_ref();
                (
                    first_string(p.and_then(|p| p.get("emails"))),
                    first_string(p.and_then(|p| p.get("phones"))),
                    first_string(p.and_then(|p| p.get("dob"))),
                    first_string(p.and_then(|p| p.get("timezone"))),
                )
            }
            MembershipStatus::AccessRemoved => (None, None, None, None),
        };
        AppUserView {
            membership_id: self.membership_id,
            uuid: self.account_uuid,
            kind: self.kind,
            id: self.handle,
            display_name: self.display_name,
            pfp_url: self.pfp_url,
            email,
            phone,
            dob,
            timezone,
            status: match self.status {
                MembershipStatus::Active => UserStatus::Active,
                MembershipStatus::Imported => UserStatus::Imported,
                MembershipStatus::AccessRemoved => UserStatus::AccessRemoved,
            },
            source: self.source,
            external_id: self.external_id,
            granted_scopes: scopes,
            first_signed_in_at: self.first_signed_in_at,
            last_signed_in_at: self.last_signed_in_at,
            created_at: self.created_at,
            account_status: self.account_status,
        }
    }
}

async fn list_users(
    State(state): State<AppState>,
    auth: AppOrOwner,
    Query(q): Query<UsersQuery>,
) -> ApiResult<Response> {
    let status = parse_choice(
        "status",
        q.status.as_deref(),
        UserStatus::parse,
        "active, imported, access_removed, deleted",
    )?;
    let kind = parse_choice(
        "kind",
        q.kind.as_deref(),
        AccountKind::parse,
        &AccountKind::expected(),
    )?;
    let source = parse_choice(
        "source",
        q.source.as_deref(),
        MembershipSource::parse,
        &MembershipSource::expected(),
    )?;
    let search = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(s) = search
        && s.chars().count() > 200
    {
        return Err(ApiError::bad_request(
            "invalid_query",
            "The search text q is longer than 200 characters.",
        )
        .hint("Search by a part of an id, display name, email, phone or external_id."));
    }
    let params = accounts_core::http::PageParams {
        limit: q.limit,
        cursor: q.cursor,
    };
    let limit = params.limit();
    let (after_ts, after_uuid) = match params.cursor::<(i64, String)>()? {
        Some((us, uuid)) => (Some(from_micros(us)?), Some(uuid)),
        None => (None, None),
    };
    let pattern = search.map(like_contains);
    // Deleted accounts: their own filter, and found only by uuid or external_id. Accounts that
    // removed the app's access are never found by their name (the app no longer sees it).
    let sql = format!(
        "{USER_SELECT} where m.app_id = $1 \
           and ($2::text is null or (case when a.status = 'deleted' then 'deleted' else m.status end) = $2) \
           and ($3::text is null or a.kind = $3) \
           and ($4::text is null or m.source = $4) \
           and ($5::text is null or ( \
                a.uuid = $6 or m.external_id ilike $5 \
                or (a.status <> 'deleted' and ( \
                  a.handle ilike $5 \
                  or (m.status <> 'access_removed' and a.display_name ilike $5) \
                  or exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(m.imported_profile->'emails') = 'array' \
                             then m.imported_profile->'emails' else '[]'::jsonb end) x where x ilike $5) \
                  or exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(m.imported_profile->'phones') = 'array' \
                             then m.imported_profile->'phones' else '[]'::jsonb end) x where x ilike $5) \
                  or (m.status = 'active' and 'email' = any(m.granted_scopes) and exists (select 1 from account_emails e \
                      where e.account_uuid = a.uuid and e.is_primary and e.email ilike $5)) \
                  or (m.status = 'active' and 'phone' = any(m.granted_scopes) and exists (select 1 from account_phones p \
                      where p.account_uuid = a.uuid and p.is_primary and p.phone ilike $5)) \
                )) \
           )) \
           and ($7::timestamptz is null or (m.created_at, m.account_uuid) < ($7, $8)) \
         order by m.created_at desc, m.account_uuid desc limit $9"
    );
    let mut conn = state.db.acquire().await?;
    let rows = sqlx::query_as::<_, UserRow>(sqlx::AssertSqlSafe(sql))
        .bind(&auth.app.app_id)
        .bind(status.map(|s| s.as_str()))
        .bind(kind.map(|k| k.as_str()))
        .bind(source.map(|s| s.as_str()))
        .bind(pattern)
        .bind(search)
        .bind(after_ts)
        .bind(after_uuid)
        .bind(limit + 1)
        .fetch_all(&mut *conn)
        .await?;
    let page = paginate(rows, limit, |r| {
        (micros(r.created_at), r.account_uuid.clone())
    });
    let iris = state.settings.iris_base_url.as_str();
    let items: Vec<AppUserView> = page.items.into_iter().map(|r| r.view(iris)).collect();
    Ok(axum::Json(json!({"items": items, "next_cursor": page.next_cursor})).into_response())
}

#[derive(Debug, sqlx::FromRow)]
struct SigninRow {
    at: OffsetDateTime,
    method: String,
    outcome: String,
}

async fn get_user(
    State(state): State<AppState>,
    auth: AppOrOwner,
    Path((app_id, uuid)): Path<(String, String)>,
) -> ApiResult<Response> {
    let mut conn = state.db.acquire().await?;
    let sql = format!("{USER_SELECT} where m.app_id = $1 and m.account_uuid = $2");
    let row = sqlx::query_as::<_, UserRow>(sqlx::AssertSqlSafe(sql))
        .bind(&auth.app.app_id)
        .bind(uuid.trim())
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "user_not_found",
                format!(
                    "No account with the uuid '{}' is in the user base of '{app_id}'.",
                    uuid.trim()
                ),
            )
            .hint("uuids are case-sensitive; list the user base with GET /v1/apps/{app_id}/users to find the right one.")
        })?;
    let history = sqlx::query_as::<_, SigninRow>(
        "select at, method, outcome from signin_history where account_uuid = $1 and app_id = $2 \
         order by at desc, id desc limit 20",
    )
    .bind(&row.account_uuid)
    .bind(&auth.app.app_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut view = serde_json::to_value(row.view(&state.settings.iris_base_url))?;
    if let Some(obj) = view.as_object_mut() {
        obj.insert(
            "history".into(),
            Value::Array(
                history
                    .into_iter()
                    .map(|h| {
                        json!({
                            "at": accounts_core::timefmt::format_rfc3339_ms(h.at),
                            "method": h.method,
                            "outcome": h.outcome,
                        })
                    })
                    .collect(),
            ),
        );
    }
    Ok(axum::Json(view).into_response())
}
