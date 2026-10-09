//! `POST /v1/me/short-lived-tokens`: a signed-in Carbon or Silicon gets a single-use token
//! (`slt_…`, 2 minutes, bound to one app) that the app exchanges for the account's tokens. This
//! is how a Silicon signs into an app: it never sees the app's sign-in page.
//!
//! Scopes (what the app will see):
//! - Silicons: `profile` plus `dob` / `timezone` when the app requires or optionally asks for
//!   them (Silicons have no email or phone, so those are simply left out, never blocking).
//! - Carbons: `profile` plus the app's required fields (409 `requirements_missing` when one is
//!   missing), plus optional fields the Carbon already granted this app on its consent screen.
//!   An app restricted to some email domains only lets in Carbons with a verified email there.
//!
//! A Silicon whose custodian set an allow-list (`/v1/me/silicons/{uuid}/allowed-apps`) only gets
//! tokens for the apps on it: 403 `app_not_allowed` otherwise.
//!
//! The token is stored under a share lock on the account row with the session re-checked
//! (`common::lock_live_session`), so it can't outlive an STK rotation or account deletion that
//! runs at the same time.

use accounts_core::error::{ApiError, ApiResult, FieldErrors};
use accounts_core::http::{AccountAuth, ClientMeta, Json};
use accounts_core::ids::validate_app_id;
use accounts_core::models::{
    Account, AccountKind, ContactField, MembershipStatus, Scope, SigninConfig, normalize_scopes,
    scopes_to_string,
};
use accounts_core::repo::{apps, contacts, memberships, tokens};
use accounts_core::state::AppState;
use accounts_core::timefmt::format_rfc3339_ms;
use axum::extract::State;
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;

use crate::common::lock_live_session;
use crate::history::Actor;

/// `POST /v1/me/short-lived-tokens` body.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SltBody {
    pub app_id: String,
}

/// `POST /v1/me/short-lived-tokens`.
pub async fn create(
    State(state): State<AppState>,
    auth: AccountAuth,
    meta: ClientMeta,
    Json(body): Json<SltBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let app_id = body.app_id.trim().to_ascii_lowercase();
    if let Err(problem) = validate_app_id(&app_id) {
        let mut fields = FieldErrors::new();
        fields.add("app_id", problem);
        return Err(ApiError::validation(fields));
    }
    if accounts_core::is_first_party_app_id(&app_id) {
        return Err(first_party_app(&app_id, &state.settings.developer_url));
    }
    if !auth.account.is_active() {
        return Err(ApiError::forbidden(
            "account_not_active",
            format!(
                "{} is {}, so it can't sign into apps.",
                auth.account.display_id(),
                auth.account.status
            ),
        ));
    }
    let mut tx = state.db.begin().await?;
    // The token is derived from this request's session, so it is stored under a share lock on
    // the account with the session re-checked: an STK rotation or account deletion running at
    // the same time either finishes first (and this refuses) or waits until the token is stored
    // (and the token is older than the rotation, so the app can't exchange it).
    let account = lock_live_session(&mut tx, &auth, "get a short-lived token").await?;
    if account.kind == AccountKind::Silicon
        && let Some(allowed) = crate::custodian_apps::allowed_apps(&mut tx, &account.uuid).await?
        && !allowed.contains(&app_id)
    {
        return Err(crate::custodian_apps::app_not_allowed(
            &account, &app_id, &allowed,
        ));
    }
    let app = apps::require_active(&mut tx, &app_id).await?;
    let config = apps::effective_config(&mut tx, &state.settings, &app_id).await?;
    let scopes = match account.kind {
        AccountKind::Silicon => silicon_scopes(&config),
        AccountKind::Carbon => {
            carbon_scopes(&mut tx, &config, &account, &app.app_id, &app.name).await?
        }
    };
    let (slt, expires_at) =
        tokens::create_slt(&mut tx, &state.keys.pepper, &account.uuid, &app_id, &scopes).await?;
    // The sign-in itself is listed when the app exchanges the token (signin_history).
    Actor::account(&account.uuid, meta.ip.as_deref())
        .record_unlisted(
            &mut tx,
            "slt.issued",
            ("account", &account.uuid),
            Some(&app_id),
            json!({"scope": scopes_to_string(&scopes)}),
        )
        .await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "slt": slt,
            "app_id": app_id,
            "expires_at": format_rfc3339_ms(expires_at),
            "scope": scopes_to_string(&scopes),
        })),
    ))
}

/// 422 `first_party_app` for Silicon Accounts' own apps (`silicon-accounts`, `developer`). Both are
/// public clients, and only an app with its own client secret can exchange a short-lived token,
/// so a token minted for either could never be used.
fn first_party_app(app_id: &str, developer_url: &str) -> ApiError {
    let message = if app_id == accounts_core::DEVELOPER_APP_ID {
        format!(
            "Short-lived tokens are for signing into other apps; 'developer' is the Silicon Accounts developer platform, which signs Carbons in on its own site ({developer_url}) and takes no short-lived tokens."
        )
    } else {
        "Short-lived tokens are for signing into other apps; 'silicon-accounts' is Silicon Accounts itself, which you are already signed into.".to_string()
    };
    ApiError::unprocessable("first_party_app", message)
        .hint("Pass the app_id of the app you want to sign into, e.g. briefcase.")
}

/// `profile` + the dob/timezone the app requires or optionally asks for.
pub fn silicon_scopes(config: &SigninConfig) -> Vec<Scope> {
    let mut scopes = vec![Scope::Profile];
    for f in config.required_fields.iter().chain(&config.optional_fields) {
        if matches!(f, ContactField::Dob | ContactField::Timezone) {
            scopes.push(f.scope());
        }
    }
    normalize_scopes(scopes)
}

async fn carbon_scopes(
    conn: &mut PgConnection,
    config: &SigninConfig,
    carbon: &Account,
    app_id: &str,
    app_name: &str,
) -> ApiResult<Vec<Scope>> {
    if !config.allowed_email_domains.is_empty() {
        let verified = contacts::verified_emails(conn, &carbon.uuid).await?;
        if !verified.iter().any(|e| config.email_domain_allowed(e)) {
            return Err(ApiError::forbidden(
                "email_domain_not_allowed",
                format!(
                    "{app_name} only lets in Carbons with a verified email at {}, and {} has none.",
                    config.allowed_email_domains.join(", "),
                    carbon.display_id()
                ),
            )
            .hint("Add and verify an email at one of those domains (`silicon-accounts email add <email>`), then ask for the token again.")
            .detail("allowed_email_domains", config.allowed_email_domains.clone()));
        }
    }
    let mut missing: Vec<&'static str> = Vec::new();
    let mut scopes = vec![Scope::Profile];
    for f in &config.required_fields {
        let present = match f {
            ContactField::Email => contacts::primary_email(conn, &carbon.uuid)
                .await?
                .is_some_and(|c| c.verified),
            ContactField::Phone => contacts::primary_phone(conn, &carbon.uuid)
                .await?
                .is_some_and(|c| c.verified),
            // Every Carbon has a date of birth and a timezone.
            ContactField::Dob | ContactField::Timezone => true,
        };
        if present {
            scopes.push(f.scope());
        } else {
            missing.push(f.as_str());
        }
    }
    if !missing.is_empty() {
        let labels: Vec<String> = missing
            .iter()
            .filter_map(|m| ContactField::parse(m))
            .map(|f| f.label().to_lowercase())
            .collect();
        return Err(ApiError::conflict(
            "requirements_missing",
            format!(
                "{app_name} requires your {}, which your account doesn't have yet.",
                labels.join(" and ")
            ),
        )
        .hint(format!(
            "Add it first ({}), then ask for the token again. Or sign into {app_id} through its sign-in page, which asks for it on the way.",
            missing
                .iter()
                .map(|m| format!("`silicon-accounts {m} add …`"))
                .collect::<Vec<_>>()
                .join(", ")
        ))
        .detail("missing", missing));
    }
    // Optional fields the Carbon already chose to share with this app on its consent screen.
    if let Some(m) = memberships::get(conn, app_id, &carbon.uuid).await?
        && m.status == MembershipStatus::Active
    {
        let granted = m.scopes();
        for f in &config.optional_fields {
            if granted.contains(&f.scope()) {
                scopes.push(f.scope());
            }
        }
    }
    Ok(normalize_scopes(scopes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_party_apps_are_named() {
        let developer = first_party_app("developer", "https://developer.example");
        assert_eq!(developer.code, "first_party_app");
        assert!(
            developer.message.contains("'developer'")
                && developer.message.contains("https://developer.example"),
            "{}",
            developer.message
        );
        let accounts = first_party_app("silicon-accounts", "https://developer.example");
        assert!(
            accounts
                .message
                .contains("'silicon-accounts' is Silicon Accounts itself"),
            "{}",
            accounts.message
        );
    }

    #[test]
    fn silicons_get_only_dob_and_timezone() {
        let config = SigninConfig {
            required_fields: vec![ContactField::Email, ContactField::Timezone],
            optional_fields: vec![ContactField::Phone, ContactField::Dob],
            ..SigninConfig::default()
        };
        assert_eq!(
            silicon_scopes(&config),
            vec![Scope::Profile, Scope::Dob, Scope::Timezone]
        );
        assert_eq!(
            silicon_scopes(&SigninConfig::default()),
            vec![Scope::Profile]
        );
    }
}
