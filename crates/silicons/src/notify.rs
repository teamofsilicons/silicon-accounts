//! What this crate tells the outside world: emails to the Carbons asked to be custodians (sent
//! through core's delivery queue) and events on a Silicon's own webhook.
//!
//! Silicon webhook events emitted here (data shapes):
//! - `silicon.created` `{uuid, id, status, silicon: Me, request: RequestInfo|null}`
//! - `silicon.custodian.accepted` `{uuid, id, request_id, custodian: AccountSummary, silicon: Me}`
//! - `silicon.custodian.declined` `{uuid, id, request_id, custodian, decided_at, reason, released: true}`
//! - `silicon.custodian.expired` `{uuid, id, request_id, custodian, expired_at, released: true}`
//! - `silicon.stk_rotated` `{uuid, id, rotated_at, rotated_by: AccountSummary}`
//!
//! (`silicon.updated`, `silicon.id_changed` and `silicon.custodian.changed` come from core's
//! `events::notify_*` helpers.)

use accounts_core::Settings;
use accounts_core::delivery::{self, NewMessage, templates};
use accounts_core::error::ApiResult;
use accounts_core::events::{self, types};
use accounts_core::models::{Account, AccountKind, MessageChannel};
use accounts_core::repo::{accounts, contacts};
use accounts_core::timefmt::format_rfc3339_ms;
use accounts_core::views::{AccountSummary, load_me};
use serde_json::json;
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::common::{custodian_not_found, lock_named_carbon};
use crate::input::CarbonTarget;
use crate::requests::CustodianRequest;
use crate::views::RequestInfo;

/// Outbound message purposes (the dev outbox and the worker show them).
pub mod purpose {
    pub const CUSTODIAN_REQUEST: &str = "custodian_request";
    pub const CUSTODIAN_INVITE: &str = "custodian_invite";
    pub const CUSTODIAN_TRANSFER: &str = "custodian_transfer";
}

/// The Carbon a request is addressed to.
#[derive(Debug, Clone)]
pub struct Recipient {
    pub target: CarbonTarget,
    /// The active Carbon behind the target: named by c:id, or owning the email (verified).
    pub account: Option<Account>,
}

impl Recipient {
    /// `to_uuid` of the request (named by c:id).
    pub fn to_uuid(&self) -> Option<&str> {
        match &self.target {
            CarbonTarget::Id(_) => self.account.as_ref().map(|a| a.uuid.as_str()),
            CarbonTarget::Email(_) => None,
        }
    }

    /// `to_email` of the request (named by email).
    pub fn to_email(&self) -> Option<&str> {
        match &self.target {
            CarbonTarget::Email(e) => Some(e.as_str()),
            CarbonTarget::Id(_) => None,
        }
    }

    /// The uuid of the Carbon behind the target, if any.
    pub fn account_uuid(&self) -> Option<&str> {
        self.account.as_ref().map(|a| a.uuid.as_str())
    }

    /// True when the target is this Carbon (their id, or one of their verified emails).
    pub async fn is_carbon(&self, conn: &mut PgConnection, carbon: &Account) -> ApiResult<bool> {
        if self.account_uuid() == Some(carbon.uuid.as_str()) {
            return Ok(true);
        }
        match &self.target {
            CarbonTarget::Email(e) => Ok(contacts::verified_emails(conn, &carbon.uuid)
                .await?
                .iter()
                .any(|v| v == e)),
            CarbonTarget::Id(id) => Ok(carbon.handle.as_deref() == Some(id.to_string().as_str())),
        }
    }

    /// Where the email about the request goes: the email it was named by, else the Carbon's
    /// primary email (none when they have no email).
    pub async fn mail_address(&self, conn: &mut PgConnection) -> ApiResult<Option<String>> {
        match (&self.target, &self.account) {
            (CarbonTarget::Email(e), _) => Ok(Some(e.clone())),
            (CarbonTarget::Id(_), Some(a)) => Ok(contacts::primary_email(conn, &a.uuid)
                .await?
                .map(|c| c.value)),
            (CarbonTarget::Id(_), None) => Ok(None),
        }
    }

    /// Inside the transaction that stores the request: for a Carbon named by c:id, share-locks it
    /// and re-checks that it is still active ([`lock_named_carbon`]), so the request can't end up
    /// addressed to an account deleted at the same moment. A request named by email needs no
    /// lock: it is addressed to whoever has that email verified when it is answered.
    pub async fn lock_named(&self, conn: &mut PgConnection, what_for: &str) -> ApiResult<()> {
        if let (CarbonTarget::Id(id), Some(a)) = (&self.target, &self.account) {
            lock_named_carbon(conn, &a.uuid, &id.to_string(), what_for).await?;
        }
        Ok(())
    }
}

/// Resolves a target. A c:id must belong to an active Carbon (404 `custodian_not_found`); an
/// email is always accepted (an invitation goes out when nobody has it yet).
pub async fn resolve_recipient(
    conn: &mut PgConnection,
    target: CarbonTarget,
    what_for: &str,
) -> ApiResult<Recipient> {
    match &target {
        CarbonTarget::Id(id) => {
            let full = id.to_string();
            match accounts::by_handle(conn, &full).await? {
                Some(a) if a.kind == AccountKind::Carbon && a.is_active() => Ok(Recipient {
                    account: Some(a),
                    target,
                }),
                _ => Err(custodian_not_found(&full, what_for)),
            }
        }
        CarbonTarget::Email(email) => {
            let account = match contacts::owner(conn, contacts::ContactKind::Email, email).await? {
                Some((uuid, true)) => accounts::get(conn, &uuid)
                    .await?
                    .filter(|a| a.kind == AccountKind::Carbon && a.is_active()),
                _ => None,
            };
            Ok(Recipient { target, account })
        }
    }
}

fn message(to: String, rendered: templates::Rendered, purpose: &str) -> NewMessage {
    NewMessage {
        channel: MessageChannel::Email,
        to,
        subject: Some(rendered.subject),
        text_body: rendered.text,
        html_body: Some(rendered.html),
        purpose: purpose.to_string(),
    }
}

/// Queues the email asking the custodian of a self-created Silicon to accept: a request when the
/// address belongs to a Carbon, an invitation to sign up otherwise. Returns the message id (send
/// it with `delivery::spawn_deliver` after the transaction commits).
///
/// Anyone can self-create a Silicon and name any c:id or email address, so these emails name the
/// Silicon by its si:id only (letters, digits, `-` and `_`) and never carry its display name: a
/// free-text field would let an anonymous caller put any words or link into an email sent from
/// our address.
pub async fn mail_initial_request(
    conn: &mut PgConnection,
    settings: &Settings,
    silicon: &Account,
    request: &CustodianRequest,
    recipient: &Recipient,
) -> ApiResult<Option<Uuid>> {
    let Some(to) = recipient.mail_address(conn).await? else {
        return Ok(None);
    };
    let silicon_id = silicon.display_id();
    let (rendered, purpose) = if recipient.account.is_some() {
        (
            self_created_request_email(&silicon_id, request.expires_at, &settings.public_url),
            purpose::CUSTODIAN_REQUEST,
        )
    } else {
        (
            self_created_invite_email(&silicon_id, request.expires_at, &settings.public_url),
            purpose::CUSTODIAN_INVITE,
        )
    };
    Ok(Some(
        delivery::enqueue(conn, settings, &message(to, rendered, purpose)).await?,
    ))
}

/// The HTML frame of every email (the same look as core's templates).
fn wrap_html(title: &str, body_html: &str) -> String {
    format!(
        "<!doctype html><html><body style=\"margin:0;padding:24px;background:#FFFDF9;color:#353432;\
         font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif\">\
         <div style=\"max-width:480px;margin:0 auto\"><p style=\"font-size:13px;color:#6F6B66\">{}</p>{}\
         <p style=\"font-size:12px;color:#6F6B66;margin-top:32px\">Sent by Silicon Accounts · \
         <a href=\"{}\" style=\"color:#1F5FB8\">account.teamofsilicons.com</a></p></div></body></html>",
        templates::escape_html(title),
        body_html,
        accounts_core::PRODUCT_SITE
    )
}

/// To a Carbon (by c:id, or an email on their account) named as custodian by a self-created
/// Silicon. Names the Silicon by its si:id only (see [`mail_initial_request`]).
pub fn self_created_request_email(
    silicon_id: &str,
    expires_at: OffsetDateTime,
    site_url: &str,
) -> templates::Rendered {
    let expires = format_rfc3339_ms(expires_at);
    let subject = format!("{silicon_id} asked you to be its custodian");
    let text = format!(
        "The Silicon {silicon_id} created its own Silicon Accounts account and named you as its custodian.\n\n\
         As its custodian you would manage its account: its details, its id and its STK. Accept or decline on \
         {site_url}/silicons before {expires}; after that the request expires and nothing changes.\n\n\
         Any Silicon can name any Carbon as its custodian, so if you don't know this Silicon, decline the request.\n"
    );
    let e = templates::escape_html;
    let html = wrap_html(
        "Custodian request",
        &format!(
            "<p>The Silicon <b>{}</b> created its own Silicon Accounts account and named you as its custodian.</p>\
             <p>As its custodian you would manage its account: its details, its id and its STK.</p>\
             <p><a href=\"{}/silicons\" style=\"color:#1F5FB8\">Accept or decline</a> before {}; after that the request expires and nothing changes.</p>\
             <p style=\"color:#6F6B66\">Any Silicon can name any Carbon as its custodian, so if you don't know this Silicon, decline the request.</p>",
            e(silicon_id),
            e(site_url),
            e(&expires)
        ),
    );
    templates::Rendered {
        subject,
        text,
        html,
    }
}

/// To an email address with no account yet, named as custodian by a self-created Silicon. Names
/// the Silicon by its si:id only (see [`mail_initial_request`]).
pub fn self_created_invite_email(
    silicon_id: &str,
    expires_at: OffsetDateTime,
    site_url: &str,
) -> templates::Rendered {
    let expires = format_rfc3339_ms(expires_at);
    let subject = format!("{silicon_id} asked you to be its custodian on Silicon Accounts");
    let text = format!(
        "The Silicon {silicon_id} created its own Silicon Accounts account and named this email address as its custodian.\n\n\
         To accept, sign up at {site_url} with this email address; the request will be waiting for you on \
         {site_url}/silicons. It expires at {expires}. Nothing changes unless you accept.\n\n\
         Any Silicon can name any email address as its custodian, so if you don't know this Silicon, ignore this email.\n"
    );
    let e = templates::escape_html;
    let html = wrap_html(
        "Custodian invitation",
        &format!(
            "<p>The Silicon <b>{}</b> created its own Silicon Accounts account and named this email address as its custodian.</p>\
             <p>To accept, <a href=\"{}\" style=\"color:#1F5FB8\">sign up</a> with this email address; the request will be waiting for you. It expires at {}. Nothing changes unless you accept.</p>\
             <p style=\"color:#6F6B66\">Any Silicon can name any email address as its custodian, so if you don't know this Silicon, ignore this email.</p>",
            e(silicon_id),
            e(site_url),
            e(&expires)
        ),
    );
    templates::Rendered {
        subject,
        text,
        html,
    }
}

/// Queues the email asking a Carbon to take over a Silicon.
pub async fn mail_transfer_request(
    conn: &mut PgConnection,
    settings: &Settings,
    silicon: &Account,
    from: &Account,
    request: &CustodianRequest,
    recipient: &Recipient,
) -> ApiResult<Option<Uuid>> {
    let Some(to) = recipient.mail_address(conn).await? else {
        return Ok(None);
    };
    let rendered = if recipient.account.is_some() {
        templates::custodian_transfer_email(
            &silicon.display_id(),
            &from.display_id(),
            request.expires_at,
            &settings.public_url,
        )
    } else {
        transfer_invite_email(
            &silicon.display_id(),
            &from.display_id(),
            request.expires_at,
            &settings.public_url,
        )
    };
    Ok(Some(
        delivery::enqueue(
            conn,
            settings,
            &message(to, rendered, purpose::CUSTODIAN_TRANSFER),
        )
        .await?,
    ))
}

/// To an email with no account yet that a custodian wants to transfer a Silicon to. (Core's
/// transfer template assumes the reader can already sign in, so it can't say to sign up.)
pub fn transfer_invite_email(
    silicon_id: &str,
    from_id: &str,
    expires_at: OffsetDateTime,
    site_url: &str,
) -> templates::Rendered {
    let expires = format_rfc3339_ms(expires_at);
    let subject = format!("{from_id} wants to transfer {silicon_id} to you on Silicon Accounts");
    let text = format!(
        "{from_id} wants to make this email address the custodian of the Silicon {silicon_id} on Silicon Accounts.\n\n\
         To accept, sign up at {site_url} with this email address; the request will be waiting for you on \
         {site_url}/silicons. It expires at {expires}. Nothing changes unless you accept.\n\n\
         If you don't know {from_id}, ignore this email.\n"
    );
    let e = templates::escape_html;
    let html = wrap_html(
        "Custodian transfer",
        &format!(
            "<p>{} wants to make this email address the custodian of the Silicon <b>{}</b> on Silicon Accounts.</p>\
             <p>To accept, <a href=\"{}\" style=\"color:#1F5FB8\">sign up</a> with this email address; the request will be waiting for you. It expires at {}. Nothing changes unless you accept.</p>\
             <p style=\"color:#6F6B66\">If you don't know {}, ignore this email.</p>",
            e(from_id),
            e(silicon_id),
            e(site_url),
            e(&expires),
            e(from_id),
        ),
    );
    templates::Rendered {
        subject,
        text,
        html,
    }
}

/// `silicon.created` to the new Silicon's webhook (no-op without one).
pub async fn silicon_created(
    conn: &mut PgConnection,
    silicon: &Account,
    request: Option<&RequestInfo>,
) -> ApiResult<()> {
    let me = load_me(conn, silicon).await?;
    events::emit_to_silicon(
        conn,
        &silicon.uuid,
        types::SILICON_CREATED,
        json!({
            "uuid": silicon.uuid, "id": silicon.handle, "status": silicon.status,
            "silicon": me, "request": request,
        }),
    )
    .await?;
    Ok(())
}

/// `silicon.custodian.accepted`: the custodian accepted; the Silicon is active and can sign in.
pub async fn custodian_accepted(
    conn: &mut PgConnection,
    silicon: &Account,
    custodian: &Account,
    request: &CustodianRequest,
) -> ApiResult<()> {
    let me = load_me(conn, silicon).await?;
    events::emit_to_silicon(
        conn,
        &silicon.uuid,
        types::SILICON_CUSTODIAN_ACCEPTED,
        json!({
            "uuid": silicon.uuid, "id": silicon.handle, "request_id": request.id.to_string(),
            "custodian": AccountSummary::from_account(custodian), "silicon": me,
        }),
    )
    .await?;
    Ok(())
}

/// `silicon.custodian.declined` (core's `events::silicon_custodian_declined`, the same payload
/// account deletion sends): emitted before the Silicon is released, while it still has its id.
/// `reason` is `declined` (the Carbon said no) or `custodian_account_deleted` (the Carbon
/// deleted their account before answering).
pub async fn custodian_declined(
    conn: &mut PgConnection,
    silicon: &Account,
    request: &CustodianRequest,
    custodian_label: &str,
    reason: &str,
) -> ApiResult<()> {
    events::silicon_custodian_declined(
        conn,
        silicon,
        request.id,
        custodian_label,
        request.decided_at,
        reason,
    )
    .await?;
    Ok(())
}

/// `silicon.custodian.expired` (core's `events::silicon_custodian_expired`): the custodian
/// didn't accept within 14 days.
pub async fn custodian_expired(
    conn: &mut PgConnection,
    silicon: &Account,
    request: &CustodianRequest,
    custodian_label: &str,
) -> ApiResult<()> {
    events::silicon_custodian_expired(
        conn,
        silicon,
        request.id,
        custodian_label,
        request.expires_at,
    )
    .await?;
    Ok(())
}

/// `silicon.stk_rotated`: the custodian replaced the STK; the old one and every session are dead.
pub async fn stk_rotated(
    conn: &mut PgConnection,
    silicon: &Account,
    rotated_at: OffsetDateTime,
    custodian: &Account,
) -> ApiResult<()> {
    events::emit_to_silicon(
        conn,
        &silicon.uuid,
        types::SILICON_STK_ROTATED,
        json!({
            "uuid": silicon.uuid, "id": silicon.handle,
            "rotated_at": format_rfc3339_ms(rotated_at),
            "rotated_by": AccountSummary::from_account(custodian),
        }),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    #[test]
    fn transfer_invite_says_to_sign_up_and_escapes() {
        let r = transfer_invite_email(
            "si:scout",
            "c:<saket>",
            datetime!(2026-10-20 10:00 UTC),
            "https://account.teamofsilicons.com",
        );
        assert!(r.subject.contains("si:scout"));
        assert!(
            r.text
                .contains("sign up at https://account.teamofsilicons.com")
        );
        assert!(r.text.contains("2026-10-20T10:00:00.000Z"));
        assert!(r.html.contains("c:&lt;saket&gt;"));
        assert!(!r.html.contains("c:<saket>"));
        assert!(
            r.html.contains("Custodian transfer") && r.html.contains("Sent by Silicon Accounts")
        );
    }

    #[test]
    fn self_created_silicon_emails_name_it_by_id_only() {
        let site = "https://account.teamofsilicons.com";
        let at = datetime!(2026-10-20 10:00 UTC);
        let request = self_created_request_email("si:scout", at, site);
        assert_eq!(request.subject, "si:scout asked you to be its custodian");
        assert!(
            request
                .text
                .contains("The Silicon si:scout created its own")
        );
        assert!(
            request
                .text
                .contains(&format!("{site}/silicons before 2026-10-20T10:00:00.000Z"))
        );
        assert!(request.text.contains("decline the request"));
        assert!(
            request.html.contains("<b>si:scout</b>") && request.html.contains("Custodian request")
        );
        let invite = self_created_invite_email("si:scout", at, site);
        assert!(invite.subject.contains("si:scout"));
        assert!(invite.text.contains(&format!("sign up at {site}")));
        assert!(invite.text.contains("ignore this email"));
        assert!(invite.html.contains("Custodian invitation"));
        // The only caller-chosen text is the si:id; HTML is still escaped defensively.
        let odd = self_created_request_email("si:<x>", at, site);
        assert!(odd.html.contains("si:&lt;x&gt;") && !odd.html.contains("si:<x>"));
    }
}
