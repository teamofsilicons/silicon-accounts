//! Domain models: enums stored as text, database rows and the sign-in configuration document.
//!
//! Every enum here serializes (JSON and Postgres) as its snake_case wire spelling, so rows decode
//! straight into them with `sqlx::FromRow`. Arrays of scopes are stored as `text[]` and handled as
//! `Vec<String>` in queries; convert with [`scopes_from_strings`] / [`scope_strings`].

use serde::Serialize;
use time::{Date, OffsetDateTime};

pub mod signin_config;

pub use signin_config::{
    AppleConfig, BackgroundStyle, Branding, ButtonStyle, ConfigSecretsPresent, CornerStyle,
    Density, FontFamily, GoogleConfig, Layout, Methods, Palette, ProviderMode, SigninConfig,
    SigninCopy, Theme, contrast_ratio, first_party_redirect_allowed, redirect_uri_matches,
};

/// Defines a fieldless enum stored and serialized as text.
macro_rules! text_enum {
    (
        $(#[$meta:meta])*
        pub enum $name:ident {
            $( $(#[$vmeta:meta])* $variant:ident = $text:literal ),+ $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum $name {
            $( $(#[$vmeta])* $variant ),+
        }

        impl $name {
            /// Every variant, in declaration order.
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            /// The wire and database spelling.
            pub const fn as_str(&self) -> &'static str {
                match self { $($name::$variant => $text),+ }
            }

            /// Parses the exact wire spelling.
            pub fn parse(s: &str) -> Option<Self> {
                match s { $($text => Some($name::$variant),)+ _ => None }
            }

            /// The accepted spellings, comma separated (for error messages).
            pub fn expected() -> String {
                [$($text),+].join(", ")
            }
        }

        impl ::std::fmt::Display for $name {
            fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl ::std::str::FromStr for $name {
            type Err = String;
            fn from_str(s: &str) -> Result<Self, String> {
                Self::parse(s).ok_or_else(|| format!("'{}' is not one of {}", s, Self::expected()))
            }
        }

        impl ::serde::Serialize for $name {
            fn serialize<S: ::serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(self.as_str())
            }
        }

        impl<'de> ::serde::Deserialize<'de> for $name {
            fn deserialize<D: ::serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let s = <String as ::serde::Deserialize>::deserialize(d)?;
                Self::parse(&s).ok_or_else(|| {
                    ::serde::de::Error::custom(format!("unknown value `{}`, expected one of {}", s, Self::expected()))
                })
            }
        }

        impl ::sqlx::Type<::sqlx::Postgres> for $name {
            fn type_info() -> ::sqlx::postgres::PgTypeInfo {
                <String as ::sqlx::Type<::sqlx::Postgres>>::type_info()
            }
            fn compatible(ty: &::sqlx::postgres::PgTypeInfo) -> bool {
                <String as ::sqlx::Type<::sqlx::Postgres>>::compatible(ty)
            }
        }

        impl ::sqlx::Encode<'_, ::sqlx::Postgres> for $name {
            fn encode_by_ref(
                &self,
                buf: &mut ::sqlx::postgres::PgArgumentBuffer,
            ) -> Result<::sqlx::encode::IsNull, ::sqlx::error::BoxDynError> {
                <&str as ::sqlx::Encode<'_, ::sqlx::Postgres>>::encode(self.as_str(), buf)
            }
        }

        impl<'r> ::sqlx::Decode<'r, ::sqlx::Postgres> for $name {
            fn decode(value: ::sqlx::postgres::PgValueRef<'r>) -> Result<Self, ::sqlx::error::BoxDynError> {
                let s = <&str as ::sqlx::Decode<'r, ::sqlx::Postgres>>::decode(value)?;
                Self::parse(s).ok_or_else(|| {
                    format!("unexpected {} value '{}' in the database", stringify!($name), s).into()
                })
            }
        }

        impl ::sqlx::postgres::PgHasArrayType for $name {
            fn array_type_info() -> ::sqlx::postgres::PgTypeInfo {
                <String as ::sqlx::postgres::PgHasArrayType>::array_type_info()
            }
        }
    };
}
pub(crate) use text_enum;

text_enum! {
    /// Carbon (a person) or Silicon (an agent).
    pub enum AccountKind {
        Carbon = "carbon",
        Silicon = "silicon",
    }
}

impl AccountKind {
    /// Id prefix including the colon: `c:` or `si:`.
    pub const fn prefix(&self) -> &'static str {
        match self {
            AccountKind::Carbon => "c:",
            AccountKind::Silicon => "si:",
        }
    }

    /// Capitalized noun for messages: `Carbon` / `Silicon`.
    pub const fn noun(&self) -> &'static str {
        match self {
            AccountKind::Carbon => "Carbon",
            AccountKind::Silicon => "Silicon",
        }
    }
}

text_enum! {
    /// Lifecycle state of an account.
    pub enum AccountStatus {
        /// Signed up (Carbon) or accepted by its custodian / created by one (Silicon).
        Active = "active",
        /// Carbon created by an app import; finishes setup at first sign-in.
        Unclaimed = "unclaimed",
        /// Self-created Silicon waiting for its custodian to accept.
        PendingCustodian = "pending_custodian",
        /// Deleted (or a released Silicon whose custodian declined / never accepted).
        Deleted = "deleted",
    }
}

text_enum! {
    /// Whether an app may sign accounts in.
    pub enum AppStatus {
        Active = "active",
        Disabled = "disabled",
    }
}

text_enum! {
    /// Where an app row came from.
    pub enum AppSource {
        FirstParty = "first_party",
        Fake = "fake",
        SiliconApps = "silicon_apps",
    }
}

text_enum! {
    /// State of an account's membership with an app.
    pub enum MembershipStatus {
        Active = "active",
        AccessRemoved = "access_removed",
        /// Created by an import; becomes active when the account signs into the app.
        Imported = "imported",
    }
}

text_enum! {
    /// How a membership was first created.
    pub enum MembershipSource {
        Signin = "signin",
        Slt = "slt",
        Import = "import",
    }
}

text_enum! {
    /// How a token family (a sign-in grant) started.
    pub enum TokenOrigin {
        AuthorizationCode = "authorization_code",
        Slt = "slt",
        SiliconLogin = "silicon_login",
        Device = "device",
        CliCode = "cli_code",
    }
}

text_enum! {
    /// How an email was proven.
    pub enum VerifiedVia {
        Code = "code",
        Google = "google",
        Apple = "apple",
    }
}

text_enum! {
    /// External identity providers.
    pub enum Provider {
        Google = "google",
        Apple = "apple",
    }
}

impl Provider {
    pub fn verified_via(&self) -> VerifiedVia {
        match self {
            Provider::Google => VerifiedVia::Google,
            Provider::Apple => VerifiedVia::Apple,
        }
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            Provider::Google => "Google",
            Provider::Apple => "Apple",
        }
    }
}

text_enum! {
    /// Carbon sign-in methods an app can enable.
    pub enum Method {
        Google = "google",
        Apple = "apple",
        Email = "email",
        Phone = "phone",
    }
}

text_enum! {
    /// Account details an app can require or optionally ask for.
    pub enum ContactField {
        Email = "email",
        Phone = "phone",
        Dob = "dob",
        Timezone = "timezone",
    }
}

impl ContactField {
    /// The scope that grants this field.
    pub fn scope(&self) -> Scope {
        match self {
            ContactField::Email => Scope::Email,
            ContactField::Phone => Scope::Phone,
            ContactField::Dob => Scope::Dob,
            ContactField::Timezone => Scope::Timezone,
        }
    }

    /// Human label used on the what's-shared screen.
    pub fn label(&self) -> &'static str {
        self.scope().label()
    }
}

text_enum! {
    /// OAuth scopes. `profile` is always granted; `openid` adds an id_token;
    /// `offline_access` is accepted and ignored (refresh tokens are always issued).
    pub enum Scope {
        Profile = "profile",
        Email = "email",
        Phone = "phone",
        Dob = "dob",
        Timezone = "timezone",
        Openid = "openid",
        OfflineAccess = "offline_access",
    }
}

impl Scope {
    /// Parses a space- (or comma-) separated scope list. Unknown scopes are an error naming them.
    pub fn parse_list(s: &str) -> Result<Vec<Scope>, String> {
        let mut out = Vec::new();
        let mut unknown = Vec::new();
        for part in s
            .split([' ', ',', '+'])
            .map(str::trim)
            .filter(|p| !p.is_empty())
        {
            match Scope::parse(part) {
                Some(sc) => out.push(sc),
                None => unknown.push(part.to_string()),
            }
        }
        if unknown.is_empty() {
            Ok(normalize_scopes(out))
        } else {
            Err(format!(
                "unknown scope(s) {}; supported scopes are {}",
                unknown
                    .iter()
                    .map(|u| format!("'{u}'"))
                    .collect::<Vec<_>>()
                    .join(", "),
                Scope::expected()
            ))
        }
    }

    /// Like [`Scope::parse_list`] but drops unknown scopes.
    pub fn parse_list_lenient(s: &str) -> Vec<Scope> {
        normalize_scopes(
            s.split([' ', ',', '+'])
                .filter_map(|p| Scope::parse(p.trim()))
                .collect(),
        )
    }

    /// The account detail this scope reveals, if any.
    pub fn contact_field(&self) -> Option<ContactField> {
        match self {
            Scope::Email => Some(ContactField::Email),
            Scope::Phone => Some(ContactField::Phone),
            Scope::Dob => Some(ContactField::Dob),
            Scope::Timezone => Some(ContactField::Timezone),
            _ => None,
        }
    }

    /// Human label for consent screens.
    pub fn label(&self) -> &'static str {
        match self {
            Scope::Profile => "Name, id and profile photo",
            Scope::Email => "Email address",
            Scope::Phone => "Phone number",
            Scope::Dob => "Date of birth",
            Scope::Timezone => "Timezone",
            Scope::Openid => "Sign-in identity (OpenID Connect)",
            Scope::OfflineAccess => "Stay signed in",
        }
    }
}

/// Dedupes, always includes `profile`, and orders scopes canonically.
pub fn normalize_scopes(mut scopes: Vec<Scope>) -> Vec<Scope> {
    scopes.push(Scope::Profile);
    scopes.sort();
    scopes.dedup();
    scopes
}

/// Space-separated canonical scope string (`"profile email"`).
pub fn scopes_to_string(scopes: &[Scope]) -> String {
    scopes
        .iter()
        .map(Scope::as_str)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Scopes as strings for `text[]` columns.
pub fn scope_strings(scopes: &[Scope]) -> Vec<String> {
    scopes.iter().map(|s| s.as_str().to_string()).collect()
}

/// Scopes from a `text[]` column (unknown values are skipped).
pub fn scopes_from_strings(values: &[String]) -> Vec<Scope> {
    normalize_scopes(values.iter().filter_map(|v| Scope::parse(v)).collect())
}

text_enum! {
    /// Why an OTP challenge was sent.
    pub enum OtpPurpose {
        Signin = "signin",
        AddEmail = "add_email",
        AddPhone = "add_phone",
        Requirement = "requirement",
        CliLogin = "cli_login",
        DeleteAccount = "delete_account",
    }
}

text_enum! {
    /// Where an OTP code goes.
    pub enum OtpChannel {
        Email = "email",
        Phone = "phone",
    }
}

text_enum! {
    /// Outbound message channel.
    pub enum MessageChannel {
        Email = "email",
        Sms = "sms",
    }
}

impl From<OtpChannel> for MessageChannel {
    fn from(c: OtpChannel) -> Self {
        match c {
            OtpChannel::Email => MessageChannel::Email,
            OtpChannel::Phone => MessageChannel::Sms,
        }
    }
}

text_enum! {
    /// Who receives a webhook event.
    pub enum WebhookTargetKind {
        App = "app",
        Silicon = "silicon",
    }
}

text_enum! {
    /// Who performed an audited action.
    pub enum ActorKind {
        Account = "account",
        App = "app",
        System = "system",
        Internal = "internal",
    }
}

/// An account row (`accounts`). `Debug` never prints the STK hash or the webhook secret.
#[derive(Clone, sqlx::FromRow)]
pub struct Account {
    pub uuid: String,
    pub number: i64,
    pub kind: AccountKind,
    /// Full id with prefix (`c:saket`); `None` once deleted/released.
    pub handle: Option<String>,
    pub status: AccountStatus,
    pub display_name: String,
    pub pfp_url: String,
    pub dob: Date,
    pub timezone: String,
    pub custodian_uuid: Option<String>,
    pub stk_hash: Option<String>,
    pub stk_failed_attempts: i32,
    pub stk_locked_until: Option<OffsetDateTime>,
    pub stk_rotated_at: Option<OffsetDateTime>,
    pub webhook_url: Option<String>,
    pub webhook_secret_enc: Option<Vec<u8>>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
    pub deleted_at: Option<OffsetDateTime>,
    pub version: i64,
}

impl Account {
    /// The full id (`c:saket`), or `""` for a deleted account.
    pub fn id(&self) -> &str {
        self.handle.as_deref().unwrap_or("")
    }

    /// The id for messages: `c:saket`, or `the deleted account a8K`.
    pub fn display_id(&self) -> String {
        match &self.handle {
            Some(h) => h.clone(),
            None => format!("the deleted account {}", self.uuid),
        }
    }

    pub fn is_carbon(&self) -> bool {
        self.kind == AccountKind::Carbon
    }

    pub fn is_silicon(&self) -> bool {
        self.kind == AccountKind::Silicon
    }

    pub fn is_active(&self) -> bool {
        self.status == AccountStatus::Active
    }

    pub fn is_deleted(&self) -> bool {
        self.status == AccountStatus::Deleted
    }

    /// `{app_id}:{uuid}`.
    pub fn membership_id(&self, app_id: &str) -> String {
        crate::ids::membership_id(app_id, &self.uuid)
    }
}

impl std::fmt::Debug for Account {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Account")
            .field("uuid", &self.uuid)
            .field("number", &self.number)
            .field("kind", &self.kind)
            .field("handle", &self.handle)
            .field("status", &self.status)
            .field("display_name", &self.display_name)
            .field("custodian_uuid", &self.custodian_uuid)
            .field("stk_set", &self.stk_hash.is_some())
            .field("webhook_url", &self.webhook_url)
            .field("version", &self.version)
            .finish_non_exhaustive()
    }
}

/// Columns of `accounts` in [`Account`] field order as a string literal, usable in `concat!`:
/// `sqlx::query_as::<_, Account>(concat!("select ", accounts_core::account_columns!(), " from accounts where uuid = $1"))`.
#[macro_export]
macro_rules! account_columns {
    () => {
        "uuid, number, kind, handle, status, display_name, pfp_url, dob, timezone, custodian_uuid, stk_hash, \
         stk_failed_attempts, stk_locked_until, stk_rotated_at, webhook_url, webhook_secret_enc, created_at, \
         updated_at, deleted_at, version"
    };
}

/// Columns of `accounts` in [`Account`] field order.
pub const ACCOUNT_COLUMNS: &str = crate::account_columns!();

/// An email on a Carbon account (`account_emails`).
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct AccountEmail {
    pub email: String,
    #[serde(skip)]
    pub account_uuid: String,
    pub is_primary: bool,
    #[serde(with = "crate::timefmt::rfc3339_ms_option")]
    pub verified_at: Option<OffsetDateTime>,
    pub verified_via: Option<VerifiedVia>,
    #[serde(with = "crate::timefmt::rfc3339_ms")]
    pub created_at: OffsetDateTime,
}

/// A phone number (E.164) on a Carbon account (`account_phones`).
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct AccountPhone {
    pub phone: String,
    #[serde(skip)]
    pub account_uuid: String,
    pub is_primary: bool,
    #[serde(with = "crate::timefmt::rfc3339_ms_option")]
    pub verified_at: Option<OffsetDateTime>,
    pub verified_via: Option<VerifiedVia>,
    #[serde(with = "crate::timefmt::rfc3339_ms")]
    pub created_at: OffsetDateTime,
}

/// A linked Google/Apple identity (`identities`).
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Identity {
    pub provider: Provider,
    pub subject: String,
    pub client_id: String,
    #[serde(skip)]
    pub account_uuid: String,
    pub email: Option<String>,
    #[serde(with = "crate::timefmt::rfc3339_ms")]
    pub created_at: OffsetDateTime,
    #[serde(with = "crate::timefmt::rfc3339_ms_option")]
    pub last_used_at: Option<OffsetDateTime>,
}

/// An app row (`apps`).
#[derive(Clone, sqlx::FromRow)]
pub struct App {
    pub app_id: String,
    pub name: String,
    pub description: String,
    pub logo_url: Option<String>,
    pub logo_dark_url: Option<String>,
    pub homepage_url: Option<String>,
    pub owner_uuid: Option<String>,
    pub secret_hash: Vec<u8>,
    pub status: AppStatus,
    pub source: AppSource,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

impl App {
    pub fn is_active(&self) -> bool {
        self.status == AppStatus::Active
    }

    pub fn is_first_party(&self) -> bool {
        self.source == AppSource::FirstParty || self.app_id == crate::FIRST_PARTY_APP_ID
    }
}

impl std::fmt::Debug for App {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("App")
            .field("app_id", &self.app_id)
            .field("name", &self.name)
            .field("owner_uuid", &self.owner_uuid)
            .field("status", &self.status)
            .field("source", &self.source)
            .finish_non_exhaustive()
    }
}

/// Columns of `apps` in [`App`] field order as a string literal (see [`account_columns!`]).
#[macro_export]
macro_rules! app_columns {
    () => {
        "app_id, name, description, logo_url, logo_dark_url, homepage_url, owner_uuid, secret_hash, status, source, \
         created_at, updated_at"
    };
}

/// Columns of `apps` in [`App`] field order.
pub const APP_COLUMNS: &str = crate::app_columns!();

/// An account's membership with an app (`memberships`).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Membership {
    pub app_id: String,
    pub account_uuid: String,
    pub membership_id: String,
    pub status: MembershipStatus,
    pub source: MembershipSource,
    pub granted_scopes: Vec<String>,
    pub external_id: Option<String>,
    pub imported_profile: Option<serde_json::Value>,
    pub first_signed_in_at: Option<OffsetDateTime>,
    pub last_signed_in_at: Option<OffsetDateTime>,
    pub access_removed_at: Option<OffsetDateTime>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

impl Membership {
    /// Granted scopes as [`Scope`]s (always includes `profile`).
    pub fn scopes(&self) -> Vec<Scope> {
        scopes_from_strings(&self.granted_scopes)
    }

    /// True when the app currently has access (active or imported).
    pub fn is_live(&self) -> bool {
        matches!(
            self.status,
            MembershipStatus::Active | MembershipStatus::Imported
        )
    }
}

/// Columns of `memberships` in [`Membership`] field order as a string literal (see [`account_columns!`]).
#[macro_export]
macro_rules! membership_columns {
    () => {
        "app_id, account_uuid, membership_id, status, source, granted_scopes, external_id, imported_profile, \
         first_signed_in_at, last_signed_in_at, access_removed_at, created_at, updated_at"
    };
}

/// Columns of `memberships` in [`Membership`] field order.
pub const MEMBERSHIP_COLUMNS: &str = crate::membership_columns!();

text_enum! {
    /// Account fields that can change (the `changed` list of `account.updated`).
    pub enum AccountField {
        DisplayName = "display_name",
        PfpUrl = "pfp_url",
        Dob = "dob",
        Timezone = "timezone",
        Email = "email",
        Phone = "phone",
    }
}

impl AccountField {
    /// The scope an app needs to see this field (`None` = always visible with `profile`).
    pub fn required_scope(&self) -> Option<Scope> {
        match self {
            AccountField::DisplayName | AccountField::PfpUrl => None,
            AccountField::Dob => Some(Scope::Dob),
            AccountField::Timezone => Some(Scope::Timezone),
            AccountField::Email => Some(Scope::Email),
            AccountField::Phone => Some(Scope::Phone),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_enums_round_trip() {
        assert_eq!(
            AccountStatus::PendingCustodian.as_str(),
            "pending_custodian"
        );
        assert_eq!(
            AccountStatus::parse("unclaimed"),
            Some(AccountStatus::Unclaimed)
        );
        assert_eq!(
            serde_json::to_string(&TokenOrigin::CliCode).expect("json"),
            "\"cli_code\""
        );
        let m: Method = serde_json::from_str("\"google\"").expect("parse");
        assert_eq!(m, Method::Google);
        let err = serde_json::from_str::<Method>("\"github\"").expect_err("unknown");
        assert!(
            err.to_string()
                .contains("expected one of google, apple, email, phone")
        );
        assert_eq!("phone".parse::<ContactField>(), Ok(ContactField::Phone));
    }

    #[test]
    fn scope_lists() {
        assert_eq!(
            Scope::parse_list("openid email  email").expect("valid"),
            vec![Scope::Profile, Scope::Email, Scope::Openid]
        );
        let err = Scope::parse_list("email files.read").expect_err("unknown");
        assert!(err.contains("'files.read'"));
        assert_eq!(
            Scope::parse_list_lenient("email files.read"),
            vec![Scope::Profile, Scope::Email]
        );
        assert_eq!(
            scopes_to_string(&[Scope::Profile, Scope::Timezone]),
            "profile timezone"
        );
        assert_eq!(
            scopes_from_strings(&["timezone".into(), "bogus".into()]),
            vec![Scope::Profile, Scope::Timezone]
        );
    }
}
