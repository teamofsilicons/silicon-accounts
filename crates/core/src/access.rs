//! Whether a Carbon may be signed into an app without the hosted sign-in pages (a device
//! sign-in approved on the account site): the app's domain rule and its required details, the
//! same rules the pages and short-lived tokens apply.

use crate::error::{ApiError, ApiResult};
use crate::models::{Account, ContactField, SigninConfig};
use crate::repo::contacts;
use sqlx::PgConnection;

/// `Ok(())` when `carbon` may sign into the app as it is now; else 403
/// `email_domain_not_allowed` (no verified email at the app's `allowed_email_domains`) or 409
/// `requirements_missing` (`details.missing`: a required email or phone it doesn't have yet).
pub async fn carbon_may_sign_in(
    conn: &mut PgConnection,
    config: &SigninConfig,
    carbon: &Account,
    app_name: &str,
) -> ApiResult<()> {
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
            .hint("Add and verify an email at one of those domains on the account site, then try again.")
            .detail("allowed_domains", config.allowed_email_domains.clone()));
        }
    }
    let mut missing: Vec<&'static str> = Vec::new();
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
        if !present {
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
        .hint("Add it on the account site (or with `silicon-accounts email add` / `phone add`), then try again.")
        .detail("missing", missing));
    }
    Ok(())
}
