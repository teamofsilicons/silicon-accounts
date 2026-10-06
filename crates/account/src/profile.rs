//! `GET /v1/me`, `PATCH /v1/me` and `POST /v1/me/id` for Carbons and Silicons.

use accounts_core::events;
use accounts_core::http::{AccountAuth, ClientMeta, IdempotencyKey, Json};
use accounts_core::ids::AccountId;
use accounts_core::models::{Account, AccountField, AccountKind};
use accounts_core::normalize;
use accounts_core::pfp;
use accounts_core::repo::accounts::{self, ProfileUpdate};
use accounts_core::repo::{idempotency, photos};
use accounts_core::timefmt;
use accounts_core::views::{self, MeView};
use accounts_core::{ApiError, ApiResult, AppState, FieldErrors, Settings};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::Date;

use crate::util::{audit_self, idem_scope, json_type, track};

/// `GET /v1/me` — the full own view (Carbon: emails, phones, identities, custodian_of;
/// Silicon: custodian, webhook_url, stk_rotated_at).
pub(crate) async fn get_me(
    State(state): State<AppState>,
    me: AccountAuth,
) -> ApiResult<Json<MeView>> {
    let mut conn = state.db.acquire().await?;
    Ok(Json(views::load_me(&mut conn, &me.account).await?))
}

/// The profile photo part of a PATCH.
#[derive(Debug, Clone, PartialEq, Eq)]
enum PfpChange {
    /// `"pfp_url": null` — back to the default Iris photo.
    Reset,
    /// A validated https URL, or a photo uploaded by this account.
    Set(String),
}

/// A validated `PATCH /v1/me` body.
#[derive(Debug, Default)]
struct ParsedPatch {
    display_name: Option<String>,
    timezone: Option<String>,
    dob: Option<Date>,
    pfp: Option<PfpChange>,
}

/// Where a field that PATCH /v1/me doesn't change is managed instead.
fn misplaced_field(key: &str, kind: AccountKind) -> String {
    match key {
        "id" | "handle" => {
            "the id can't be changed with PATCH /v1/me; use POST /v1/me/id {\"id\":\"…\"} (the old id stays reserved for you for 10 days)".into()
        }
        "email" | "emails" => {
            "emails are managed with POST /v1/me/emails (add, then verify the code), POST /v1/me/emails/{email}/primary and DELETE /v1/me/emails/{email}".into()
        }
        "phone" | "phones" => {
            "phone numbers are managed with POST /v1/me/phones (add, then verify the code), POST /v1/me/phones/{phone}/primary and DELETE /v1/me/phones/{phone}".into()
        }
        "identities" => {
            "linked identities are listed at GET /v1/me/identities and disconnected with DELETE /v1/me/identities/{provider}/{subject}".into()
        }
        "webhook_url" | "webhook" => match kind {
            AccountKind::Silicon => {
                "a Silicon sets its webhook with PUT /v1/me/webhook {\"url\":\"…\"} and removes it with DELETE /v1/me/webhook".into()
            }
            AccountKind::Carbon => "Carbons have no webhook; apps register theirs in Silicon Apps".into(),
        },
        "custodian" => {
            "a Silicon's custodian only changes by a transfer its custodian starts (POST /v1/me/silicons/{uuid}/transfer) and the new Carbon accepts".into()
        }
        "stk" => {
            "a Silicon's STK is rotated by its custodian with POST /v1/me/silicons/{uuid}/stk".into()
        }
        "uuid" | "kind" | "status" | "created_at" | "updated_at" | "version" | "custodian_of"
        | "stk_rotated_at" => format!("{key} is read-only"),
        _ => "is not a field of PATCH /v1/me; the fields you can change are display_name, timezone, dob (Carbons only) and pfp_url".into(),
    }
}

fn dob_immutable(account: &Account) -> ApiError {
    ApiError::unprocessable(
        "dob_immutable",
        format!(
            "A Silicon's date of birth is the day its account was created ({}) and can't change.",
            timefmt::format_date(account.dob)
        ),
    )
    .hint("Leave dob out of the request.")
}

/// Validates a PATCH body against the account's kind. Every problem is reported at once
/// (422 `validation_failed` with `details.fields`); a Silicon changing its dob gets 422
/// `dob_immutable`.
fn parse_patch(settings: &Settings, account: &Account, body: &Value) -> ApiResult<ParsedPatch> {
    let Value::Object(map) = body else {
        let mut f = FieldErrors::new();
        f.add(
            "body",
            format!(
                "must be a JSON object such as {{\"display_name\":\"Saket\"}}, not {}",
                json_type(body)
            ),
        );
        return Err(ApiError::validation(f));
    };
    let mut fields = FieldErrors::new();
    let mut out = ParsedPatch::default();
    let today = timefmt::today_utc();
    for (key, value) in map {
        match key.as_str() {
            "display_name" => match value.as_str() {
                Some(s) => match normalize::validate_display_name(s) {
                    Ok(v) => out.display_name = Some(v),
                    Err(m) => fields.add(key, m),
                },
                None => fields.add(
                    key,
                    format!("must be a string of 1 to 100 characters, not {}", json_type(value)),
                ),
            },
            "timezone" => match value.as_str() {
                Some(s) => match normalize::normalize_timezone(s) {
                    Ok(v) => out.timezone = Some(v),
                    Err(m) => fields.add(key, m),
                },
                None => fields.add(
                    key,
                    format!(
                        "must be an IANA timezone name like Asia/Kolkata, not {}",
                        json_type(value)
                    ),
                ),
            },
            "dob" => {
                let parsed = value.as_str().map(timefmt::parse_date);
                if account.kind == AccountKind::Silicon {
                    // Sending the current dob back is harmless; anything else is a change.
                    match parsed {
                        Some(Ok(d)) if d == account.dob => {}
                        _ => return Err(dob_immutable(account)),
                    }
                    continue;
                }
                match parsed {
                    Some(Ok(d)) => match normalize::validate_dob(d, today) {
                        Ok(d) => out.dob = Some(d),
                        Err(m) => fields.add(key, m),
                    },
                    Some(Err(m)) => fields.add(key, m),
                    None => fields.add(
                        key,
                        format!(
                            "must be a date string in YYYY-MM-DD format, not {}",
                            json_type(value)
                        ),
                    ),
                }
            }
            "pfp_url" => match value {
                Value::Null => out.pfp = Some(PfpChange::Reset),
                Value::String(s) => match normalize::validate_pfp_url(settings, s) {
                    Ok(v) => out.pfp = Some(PfpChange::Set(v)),
                    Err(m) => fields.add(
                        key,
                        format!("{m}; use an https URL, upload a photo with POST /v1/me/photo, or send null for the default photo"),
                    ),
                },
                other => fields.add(
                    key,
                    format!(
                        "must be an https URL string, or null for the default photo, not {}",
                        json_type(other)
                    ),
                ),
            },
            other => fields.add(other, misplaced_field(other, account.kind)),
        }
    }
    fields.into_result()?;
    Ok(out)
}

/// `PATCH /v1/me` `{"display_name"?,"timezone"?,"dob"?,"pfp_url"?}` → Me. Only real changes
/// are written; then `version` bumps, member apps get `account.updated` with the changed fields
/// they can see (apps that can see none are skipped), and a Silicon's own webhook gets
/// `silicon.updated`. A Silicon's dob is immutable (422 `dob_immutable`). `"pfp_url": null`
/// resets the photo. Accepts `Idempotency-Key`.
pub(crate) async fn patch_me(
    State(state): State<AppState>,
    me: AccountAuth,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let patch = parse_patch(&state.settings, &me.account, &body)?;
    let scope = idem_scope(me.uuid(), "PATCH", "/v1/me");
    idempotency::run(&state, key.as_deref(), &scope, &body, false, || async {
        let mut tx = state.db.begin().await?;
        // The row lock comes first: photo uploads and removals prune under it, so a photo
        // checked below stays in place until this change commits.
        let current = accounts::lock(&mut tx, me.uuid())
            .await?
            .ok_or_else(|| account_not_found(me.uuid()))?;
        let pfp_url = match &patch.pfp {
            None => None,
            Some(PfpChange::Reset) => Some(pfp::default_pfp_url(
                &state.settings.iris_base_url,
                me.kind(),
                me.uuid(),
            )),
            Some(PfpChange::Set(url)) => {
                // Sending back the current pfp_url changes nothing, even when it's a photo the
                // account didn't upload (such as a Silicon's photo set by its custodian). A new
                // photo of this service must be one this account uploaded (core's check, under
                // the row lock taken above, so pruning can't remove it before this commits).
                if *url != current.pfp_url {
                    photos::check_usable(&mut tx, &state.settings, url, &[me.uuid()], "you")
                        .await?;
                }
                Some(url.clone())
            }
        };
        let (account, changed) = accounts::update_profile(
            &mut tx,
            me.uuid(),
            &ProfileUpdate {
                display_name: patch.display_name.clone(),
                timezone: patch.timezone.clone(),
                dob: patch.dob,
                pfp_url,
            },
        )
        .await?;
        if !changed.is_empty() {
            events::notify_profile_updated(&mut tx, &account, &changed).await?;
            if changed.contains(&AccountField::PfpUrl) {
                photos::prune(&mut tx, &state.settings, me.uuid()).await?;
            }
            audit_self(
                &mut tx,
                me.uuid(),
                "account.profile.updated",
                None,
                json!({ "changed": changed }),
                meta.ip.as_deref(),
            )
            .await?;
        }
        tx.commit().await?;
        if !changed.is_empty() {
            track(
                &state,
                "profile",
                "account.profile.updated",
                json!({ "kind": me.kind(), "changed": changed }),
            );
        }
        let mut conn = state.db.acquire().await?;
        let view = views::load_me(&mut conn, &account).await?;
        Ok((StatusCode::OK, serde_json::to_value(view)?))
    })
    .await
}

fn account_not_found(uuid: &str) -> ApiError {
    ApiError::not_found(
        "account_not_found",
        format!("No account has the uuid '{uuid}'."),
    )
}

/// Most id changes one account can make per rolling 24 hours (core's
/// `accounts::ID_CHANGES_PER_DAY`, enforced by `accounts::change_id` for every caller, a Silicon's
/// custodian included).
pub const ID_CHANGES_PER_DAY: i64 = accounts::ID_CHANGES_PER_DAY;

/// The rolling window of [`ID_CHANGES_PER_DAY`]: 24 hours.
pub const ID_CHANGE_WINDOW_SECONDS: i64 = accounts::ID_CHANGE_WINDOW_SECONDS;

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct ChangeIdBody {
    id: String,
}

/// `POST /v1/me/id` `{"id":"c:new"}` (a bare handle gets the account's prefix) → Me. The old id
/// is reserved for this account for 10 days; taking back one's own reserved id deletes the
/// reservation. Member apps get `account.id_changed`, a Silicon's webhook `silicon.id_changed`.
/// At most [`ID_CHANGES_PER_DAY`] changes per 24 hours (429 `rate_limited`). Errors: 422
/// `invalid_id`, 409 `id_taken` (with suggestions) / `id_reserved`. Accepts `Idempotency-Key`.
pub(crate) async fn change_id(
    State(state): State<AppState>,
    me: AccountAuth,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Json(body): Json<ChangeIdBody>,
) -> Result<Response, ApiError> {
    let scope = idem_scope(me.uuid(), "POST", "/v1/me/id");
    idempotency::run(&state, key.as_deref(), &scope, &body, false, || async {
        let new_id = AccountId::parse_for_kind(&body.id, me.kind())
            .map_err(|e| accounts::invalid_id_error(&e))?;
        let mut tx = state.db.begin().await?;
        // Core counts the change against the 24-hour budget under the account's row lock (429
        // `rate_limited`); asking for the current id again is a no-op that never counts, and a
        // deleted account gets 409 `account_deleted`.
        let change = accounts::change_id(&mut tx, me.uuid(), &new_id, me.uuid()).await?;
        if change.changed {
            events::notify_id_changed(&mut tx, &change.account, &change.old_id, &change.new_id)
                .await?;
            audit_self(
                &mut tx,
                me.uuid(),
                "account.id.changed",
                None,
                json!({
                    "old_id": change.old_id, "new_id": change.new_id, "reclaimed": change.reclaimed,
                }),
                meta.ip.as_deref(),
            )
            .await?;
        }
        tx.commit().await?;
        if change.changed {
            track(
                &state,
                "id",
                "account.id.changed",
                json!({ "kind": me.kind(), "reclaimed": change.reclaimed }),
            );
        }
        let mut conn = state.db.acquire().await?;
        let view = views::load_me(&mut conn, &change.account).await?;
        Ok((StatusCode::OK, serde_json::to_value(view)?))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use accounts_core::models::AccountStatus;
    use time::macros::{date, datetime};

    fn account(kind: AccountKind) -> Account {
        Account {
            uuid: "a8K".into(),
            number: 1,
            kind,
            handle: Some(
                if kind == AccountKind::Carbon {
                    "c:saket"
                } else {
                    "si:scout"
                }
                .into(),
            ),
            status: AccountStatus::Active,
            display_name: "Saket".into(),
            pfp_url: "https://iris.teamofsilicons.com/pfp/carbon?id=a8K".into(),
            dob: date!(2000 - 01 - 01),
            timezone: "UTC".into(),
            custodian_uuid: None,
            stk_hash: None,
            stk_failed_attempts: 0,
            stk_locked_until: None,
            stk_rotated_at: None,
            webhook_url: None,
            webhook_secret_enc: None,
            created_at: datetime!(2026-10-01 00:00 UTC),
            updated_at: datetime!(2026-10-01 00:00 UTC),
            deleted_at: None,
            version: 1,
        }
    }

    #[test]
    fn parses_and_validates_every_field() {
        let s = Settings::for_tests();
        let c = account(AccountKind::Carbon);
        let p = parse_patch(
            &s,
            &c,
            &json!({"display_name": "  Saket D ", "timezone": "asia/kolkata", "dob": "1999-02-03", "pfp_url": null}),
        )
        .expect("valid");
        assert_eq!(p.display_name.as_deref(), Some("Saket D"));
        assert_eq!(p.timezone.as_deref(), Some("Asia/Kolkata"));
        assert_eq!(p.dob, Some(date!(1999 - 02 - 03)));
        assert_eq!(p.pfp, Some(PfpChange::Reset));

        let e = parse_patch(
            &s,
            &c,
            &json!({"display_name": "", "timezone": "Mars/Base", "dob": "2999-01-01", "pfp_url": "http://x.test/a.png", "id": "c:x", "bogus": 1}),
        )
        .expect_err("invalid");
        assert_eq!(e.code, "validation_failed");
        let fields = &e.details["fields"];
        for f in ["display_name", "timezone", "dob", "pfp_url", "id", "bogus"] {
            assert!(fields.get(f).is_some(), "{f} missing in {fields}");
        }
        assert!(
            fields["id"]
                .as_str()
                .is_some_and(|m| m.contains("POST /v1/me/id"))
        );

        let e = parse_patch(&s, &c, &json!(["x"])).expect_err("not an object");
        assert!(
            e.details["fields"]["body"]
                .as_str()
                .is_some_and(|m| m.contains("a list"))
        );
    }

    #[test]
    fn silicon_dob_is_immutable() {
        let s = Settings::for_tests();
        let si = account(AccountKind::Silicon);
        assert!(parse_patch(&s, &si, &json!({"dob": "2000-01-01"})).is_ok());
        let e = parse_patch(&s, &si, &json!({"dob": "2001-01-01"})).expect_err("immutable");
        assert_eq!(e.code, "dob_immutable");
        let e = parse_patch(&s, &si, &json!({"dob": null})).expect_err("immutable");
        assert_eq!(e.code, "dob_immutable");
        let e =
            parse_patch(&s, &si, &json!({"webhook_url": "https://x.test"})).expect_err("misplaced");
        assert!(
            e.details["fields"]["webhook_url"]
                .as_str()
                .is_some_and(|m| m.contains("PUT /v1/me/webhook"))
        );
    }
}
