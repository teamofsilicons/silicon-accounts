//! API views (the JSON shapes in 02-api.md) and the database-backed builders for them.
//!
//! - [`AccountSummary`] — public-ish identity (lookups, custodian refs, lists).
//! - [`MeView`] — `GET /v1/me` (Carbon or Silicon variant); build with [`load_me`].
//! - [`AccountForApp`] — what an app sees, limited by granted scopes; build with
//!   [`load_account_for_app`] or [`AccountForApp::build`].
//! - [`TokenResponse`] — the token endpoint body (built by `repo::tokens::issue_tokens`).
//! - [`AppSummary`], [`Page`].

use serde::{Deserialize, Serialize};
use sqlx::PgConnection;
use time::{Date, OffsetDateTime};

use crate::error::ApiResult;
use crate::models::{
    Account, AccountEmail, AccountKind, AccountPhone, AccountStatus, App, Identity, Provider,
    Scope, VerifiedVia,
};

/// `{"uuid","kind","id","display_name","pfp_url","status"}`. `id` is null for deleted accounts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountSummary {
    pub uuid: String,
    pub kind: AccountKind,
    pub id: Option<String>,
    pub display_name: String,
    pub pfp_url: String,
    pub status: AccountStatus,
}

impl AccountSummary {
    pub fn from_account(a: &Account) -> AccountSummary {
        AccountSummary {
            uuid: a.uuid.clone(),
            kind: a.kind,
            id: a.handle.clone(),
            display_name: a.display_name.clone(),
            pfp_url: a.pfp_url.clone(),
            status: a.status,
        }
    }
}

impl From<&Account> for AccountSummary {
    fn from(a: &Account) -> Self {
        AccountSummary::from_account(a)
    }
}

/// `{"uuid","id"}` — a Silicon's custodian as apps see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustodianRef {
    pub uuid: String,
    pub id: Option<String>,
}

/// An email in `Me.emails`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmailView {
    pub email: String,
    pub is_primary: bool,
    #[serde(with = "crate::timefmt::rfc3339_ms_option")]
    pub verified_at: Option<OffsetDateTime>,
    pub verified_via: Option<VerifiedVia>,
}

impl From<&AccountEmail> for EmailView {
    fn from(e: &AccountEmail) -> Self {
        EmailView {
            email: e.email.clone(),
            is_primary: e.is_primary,
            verified_at: e.verified_at,
            verified_via: e.verified_via,
        }
    }
}

/// A phone number in `Me.phones`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PhoneView {
    pub phone: String,
    pub is_primary: bool,
    #[serde(with = "crate::timefmt::rfc3339_ms_option")]
    pub verified_at: Option<OffsetDateTime>,
}

impl From<&AccountPhone> for PhoneView {
    fn from(p: &AccountPhone) -> Self {
        PhoneView {
            phone: p.phone.clone(),
            is_primary: p.is_primary,
            verified_at: p.verified_at,
        }
    }
}

/// A linked identity in `Me.identities`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdentityView {
    pub provider: Provider,
    pub subject: String,
    pub email: Option<String>,
    #[serde(with = "crate::timefmt::rfc3339_ms")]
    pub created_at: OffsetDateTime,
    #[serde(with = "crate::timefmt::rfc3339_ms_option")]
    pub last_used_at: Option<OffsetDateTime>,
}

impl From<&Identity> for IdentityView {
    fn from(i: &Identity) -> Self {
        IdentityView {
            provider: i.provider,
            subject: i.subject.clone(),
            email: i.email.clone(),
            created_at: i.created_at,
            last_used_at: i.last_used_at,
        }
    }
}

/// `GET /v1/me`. Carbon-only fields are omitted for Silicons and vice versa.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeView {
    pub uuid: String,
    pub kind: AccountKind,
    pub id: Option<String>,
    pub display_name: String,
    pub pfp_url: String,
    #[serde(with = "crate::timefmt::date")]
    pub dob: Date,
    pub timezone: String,
    pub status: AccountStatus,
    #[serde(with = "crate::timefmt::rfc3339_ms")]
    pub created_at: OffsetDateTime,
    #[serde(with = "crate::timefmt::rfc3339_ms")]
    pub updated_at: OffsetDateTime,
    pub version: i64,
    // Carbon only
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub emails: Option<Vec<EmailView>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub phones: Option<Vec<PhoneView>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub identities: Option<Vec<IdentityView>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub custodian_of: Option<i64>,
    // Silicon only (`custodian` is present and may be null)
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub custodian: Option<Option<AccountSummary>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub webhook_url: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none", default, with = "opt_opt_ts")]
    pub stk_rotated_at: Option<Option<OffsetDateTime>>,
}

mod opt_opt_ts {
    use serde::{Deserialize, Deserializer, Serializer};
    use time::OffsetDateTime;

    pub fn serialize<S: Serializer>(
        v: &Option<Option<OffsetDateTime>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        match v {
            Some(Some(t)) => s.serialize_str(&crate::timefmt::format_rfc3339_ms(*t)),
            _ => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Option<Option<OffsetDateTime>>, D::Error> {
        let v = Option::<String>::deserialize(d)?;
        match v {
            Some(s) => crate::timefmt::parse_rfc3339(&s)
                .map(|t| Some(Some(t)))
                .map_err(serde::de::Error::custom),
            None => Ok(Some(None)),
        }
    }
}

impl MeView {
    fn base(a: &Account) -> MeView {
        MeView {
            uuid: a.uuid.clone(),
            kind: a.kind,
            id: a.handle.clone(),
            display_name: a.display_name.clone(),
            pfp_url: a.pfp_url.clone(),
            dob: a.dob,
            timezone: a.timezone.clone(),
            status: a.status,
            created_at: a.created_at,
            updated_at: a.updated_at,
            version: a.version,
            emails: None,
            phones: None,
            identities: None,
            custodian_of: None,
            custodian: None,
            webhook_url: None,
            stk_rotated_at: None,
        }
    }

    /// The Carbon variant.
    pub fn carbon(
        a: &Account,
        emails: &[AccountEmail],
        phones: &[AccountPhone],
        identities: &[Identity],
        custodian_of: i64,
    ) -> MeView {
        let mut m = MeView::base(a);
        m.emails = Some(emails.iter().map(EmailView::from).collect());
        m.phones = Some(phones.iter().map(PhoneView::from).collect());
        m.identities = Some(identities.iter().map(IdentityView::from).collect());
        m.custodian_of = Some(custodian_of);
        m
    }

    /// The Silicon variant.
    pub fn silicon(a: &Account, custodian: Option<AccountSummary>) -> MeView {
        let mut m = MeView::base(a);
        m.custodian = Some(custodian);
        m.webhook_url = Some(a.webhook_url.clone());
        m.stk_rotated_at = Some(a.stk_rotated_at);
        m
    }
}

/// Loads everything `GET /v1/me` shows for an account.
pub async fn load_me(conn: &mut PgConnection, account: &Account) -> ApiResult<MeView> {
    match account.kind {
        AccountKind::Carbon => {
            let emails = crate::repo::contacts::list_emails(conn, &account.uuid).await?;
            let phones = crate::repo::contacts::list_phones(conn, &account.uuid).await?;
            let identities = crate::repo::identities::list_for_account(conn, &account.uuid).await?;
            let custodian_of =
                crate::repo::accounts::count_silicons_in_custody(conn, &account.uuid).await?;
            Ok(MeView::carbon(
                account,
                &emails,
                &phones,
                &identities,
                custodian_of,
            ))
        }
        AccountKind::Silicon => {
            let custodian = match &account.custodian_uuid {
                Some(c) => crate::repo::accounts::get(conn, c)
                    .await?
                    .as_ref()
                    .map(AccountSummary::from_account),
                None => None,
            };
            Ok(MeView::silicon(account, custodian))
        }
    }
}

/// What an app sees about an account. `profile` fields are always present; `email`, `phone`,
/// `dob` and `timezone` only with their scope; Silicons never have email/phone and always carry
/// `custodian`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountForApp {
    pub uuid: String,
    pub membership_id: String,
    pub kind: AccountKind,
    pub id: Option<String>,
    pub display_name: String,
    pub pfp_url: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub email_verified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub phone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub phone_verified: Option<bool>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        with = "crate::timefmt::date_option"
    )]
    pub dob: Option<Date>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub timezone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub custodian: Option<CustodianRef>,
    #[serde(with = "crate::timefmt::rfc3339_ms")]
    pub updated_at: OffsetDateTime,
    pub version: i64,
}

/// A primary contact: value + verified flag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrimaryContact {
    pub value: String,
    pub verified: bool,
}

impl AccountForApp {
    /// Builds the scoped view from already-loaded data.
    pub fn build(
        account: &Account,
        app_id: &str,
        scopes: &[Scope],
        primary_email: Option<PrimaryContact>,
        primary_phone: Option<PrimaryContact>,
        custodian: Option<CustodianRef>,
    ) -> AccountForApp {
        let carbon = account.kind == AccountKind::Carbon;
        let (email, email_verified) =
            match (carbon && scopes.contains(&Scope::Email), primary_email) {
                (true, Some(c)) => (Some(c.value), Some(c.verified)),
                _ => (None, None),
            };
        let (phone, phone_verified) =
            match (carbon && scopes.contains(&Scope::Phone), primary_phone) {
                (true, Some(c)) => (Some(c.value), Some(c.verified)),
                _ => (None, None),
            };
        AccountForApp {
            uuid: account.uuid.clone(),
            membership_id: crate::ids::membership_id(app_id, &account.uuid),
            kind: account.kind,
            id: account.handle.clone(),
            display_name: account.display_name.clone(),
            pfp_url: account.pfp_url.clone(),
            email,
            email_verified,
            phone,
            phone_verified,
            dob: scopes.contains(&Scope::Dob).then_some(account.dob),
            timezone: scopes
                .contains(&Scope::Timezone)
                .then(|| account.timezone.clone()),
            custodian: if account.kind == AccountKind::Silicon {
                custodian
            } else {
                None
            },
            updated_at: account.updated_at,
            version: account.version,
        }
    }

    /// OIDC userinfo aliases merged into the view (`sub`, `name`, `picture`, `email`,
    /// `email_verified`, `phone_number`, `phone_number_verified`, `zoneinfo`, `birthdate`).
    pub fn userinfo_json(&self) -> serde_json::Value {
        let mut v = serde_json::to_value(self).unwrap_or_else(|_| serde_json::json!({}));
        if let Some(obj) = v.as_object_mut() {
            obj.insert("sub".into(), self.uuid.clone().into());
            obj.insert("name".into(), self.display_name.clone().into());
            obj.insert("picture".into(), self.pfp_url.clone().into());
            if let Some(p) = &self.phone {
                obj.insert("phone_number".into(), p.clone().into());
                obj.insert(
                    "phone_number_verified".into(),
                    self.phone_verified.unwrap_or(false).into(),
                );
            }
            if let Some(tz) = &self.timezone {
                obj.insert("zoneinfo".into(), tz.clone().into());
            }
            if let Some(d) = self.dob {
                obj.insert("birthdate".into(), crate::timefmt::format_date(d).into());
            }
        }
        v
    }
}

/// Loads the scoped app view (primary contacts and custodian come from the database).
pub async fn load_account_for_app(
    conn: &mut PgConnection,
    account: &Account,
    app_id: &str,
    scopes: &[Scope],
) -> ApiResult<AccountForApp> {
    let (email, phone) = if account.kind == AccountKind::Carbon {
        (
            crate::repo::contacts::primary_email(conn, &account.uuid).await?,
            crate::repo::contacts::primary_phone(conn, &account.uuid).await?,
        )
    } else {
        (None, None)
    };
    let custodian = match (&account.kind, &account.custodian_uuid) {
        (AccountKind::Silicon, Some(c)) => {
            let handle = crate::repo::accounts::get(conn, c)
                .await?
                .and_then(|a| a.handle);
            Some(CustodianRef {
                uuid: c.clone(),
                id: handle,
            })
        }
        _ => None,
    };
    Ok(AccountForApp::build(
        account, app_id, scopes, email, phone, custodian,
    ))
}

/// The token endpoint response. `Debug` never prints the tokens themselves.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub token_type: String,
    pub expires_in: i64,
    pub refresh_token: String,
    #[serde(with = "crate::timefmt::rfc3339_ms")]
    pub refresh_token_expires_at: OffsetDateTime,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub id_token: Option<String>,
    pub membership_id: String,
    pub account: AccountForApp,
}

impl std::fmt::Debug for TokenResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenResponse")
            .field("access_token", &"[redacted]")
            .field("token_type", &self.token_type)
            .field("expires_in", &self.expires_in)
            .field("refresh_token", &"[redacted]")
            .field("refresh_token_expires_at", &self.refresh_token_expires_at)
            .field("scope", &self.scope)
            .field("id_token", &self.id_token.as_ref().map(|_| "[redacted]"))
            .field("membership_id", &self.membership_id)
            .field("account", &self.account)
            .finish()
    }
}

/// `{"app_id","name","logo_url","logo_dark_url","homepage_url"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppSummary {
    pub app_id: String,
    pub name: String,
    pub logo_url: Option<String>,
    pub logo_dark_url: Option<String>,
    pub homepage_url: Option<String>,
}

impl From<&App> for AppSummary {
    fn from(a: &App) -> Self {
        AppSummary {
            app_id: a.app_id.clone(),
            name: a.name.clone(),
            logo_url: a.logo_url.clone(),
            logo_dark_url: a.logo_dark_url.clone(),
            homepage_url: a.homepage_url.clone(),
        }
    }
}

/// `{"items":[...],"next_cursor":null}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

impl<T> Page<T> {
    pub fn new(items: Vec<T>, next_cursor: Option<String>) -> Self {
        Page { items, next_cursor }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::{date, datetime};

    fn account(kind: AccountKind) -> Account {
        Account {
            uuid: "a8K".into(),
            number: 7,
            kind,
            handle: Some(if kind == AccountKind::Carbon {
                "c:saket".into()
            } else {
                "si:scout".into()
            }),
            status: AccountStatus::Active,
            display_name: "Saket".into(),
            pfp_url: "https://iris.teamofsilicons.com/pfp/carbon?id=a8K".into(),
            dob: date!(2000 - 01 - 01),
            timezone: "Asia/Kolkata".into(),
            custodian_uuid: (kind == AccountKind::Silicon).then(|| "zQo".into()),
            stk_hash: None,
            stk_failed_attempts: 0,
            stk_locked_until: None,
            stk_rotated_at: None,
            webhook_url: None,
            webhook_secret_enc: None,
            created_at: datetime!(2026-10-06 12:00 UTC),
            updated_at: datetime!(2026-10-06 12:00 UTC),
            deleted_at: None,
            version: 3,
        }
    }

    #[test]
    fn account_for_app_respects_scopes() {
        let a = account(AccountKind::Carbon);
        let email = Some(PrimaryContact {
            value: "a@b.co".into(),
            verified: true,
        });
        let phone = Some(PrimaryContact {
            value: "+919876543210".into(),
            verified: true,
        });
        let v = AccountForApp::build(
            &a,
            "briefcase",
            &[Scope::Profile],
            email.clone(),
            phone.clone(),
            None,
        );
        let j = serde_json::to_value(&v).expect("json");
        assert_eq!(j["membership_id"], "briefcase:a8K");
        assert!(j.get("email").is_none() && j.get("phone").is_none() && j.get("dob").is_none());
        assert_eq!(j["updated_at"], "2026-10-06T12:00:00.000Z");

        let v = AccountForApp::build(
            &a,
            "briefcase",
            &[Scope::Profile, Scope::Email, Scope::Dob, Scope::Timezone],
            email,
            phone,
            None,
        );
        let j = serde_json::to_value(&v).expect("json");
        assert_eq!(j["email"], "a@b.co");
        assert_eq!(j["email_verified"], true);
        assert_eq!(j["dob"], "2000-01-01");
        assert_eq!(j["timezone"], "Asia/Kolkata");
        assert!(j.get("phone").is_none());
        let u = v.userinfo_json();
        assert_eq!(u["sub"], "a8K");
        assert_eq!(u["zoneinfo"], "Asia/Kolkata");
        assert_eq!(u["birthdate"], "2000-01-01");
    }

    #[test]
    fn silicons_never_expose_contacts_and_carry_custodian() {
        let s = account(AccountKind::Silicon);
        let v = AccountForApp::build(
            &s,
            "remind",
            &[Scope::Profile, Scope::Email, Scope::Phone],
            Some(PrimaryContact {
                value: "x@y.co".into(),
                verified: true,
            }),
            None,
            Some(CustodianRef {
                uuid: "zQo".into(),
                id: Some("c:saket".into()),
            }),
        );
        let j = serde_json::to_value(&v).expect("json");
        assert!(j.get("email").is_none());
        assert_eq!(j["custodian"]["id"], "c:saket");
    }

    #[test]
    fn me_view_variants() {
        let c = MeView::carbon(&account(AccountKind::Carbon), &[], &[], &[], 2);
        let j = serde_json::to_value(&c).expect("json");
        assert_eq!(j["custodian_of"], 2);
        assert_eq!(j["dob"], "2000-01-01");
        assert!(j.get("custodian").is_none() && j.get("webhook_url").is_none());

        let s = MeView::silicon(&account(AccountKind::Silicon), None);
        let j = serde_json::to_value(&s).expect("json");
        assert!(j.get("emails").is_none());
        assert_eq!(j["custodian"], serde_json::Value::Null);
        assert!(j.as_object().expect("object").contains_key("custodian"));
        assert!(
            j.as_object()
                .expect("object")
                .contains_key("stk_rotated_at")
        );
    }
}
