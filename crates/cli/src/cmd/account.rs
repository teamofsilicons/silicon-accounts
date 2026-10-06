//! Account commands: whoami, id, lookup, profile, email, phone, identities, apps, proofs,
//! sessions, history, delete-account, device.

use std::path::Path;

use serde_json::json;
use silicon_accounts_client::{AccountKind, AccountSummary, HistoryQuery, Me, ProfileUpdate};

use crate::cli::{
    DeleteAccountArgs, DeviceArgs, DeviceCommand, EmailArgs, EmailCommand, HistoryArgs, IdArgs,
    IdCommand, IdentitiesArgs, IdentitiesCommand, MyAppsArgs, MyAppsCommand, MyProofsArgs,
    MyProofsCommand, PhoneArgs, PhoneCommand, ProfileArgs, ProfileCommand, ProfileSetArgs,
    SessionsArgs, SessionsCommand,
};
use crate::ctx::Ctx;
use crate::error::{CliError, CliResult, EXIT_CONFLICT, EXIT_INVALID};
use crate::output::{Outcome, kv, stamp, table, to_json, when};
use crate::util;
use crate::with_session;

/// Plain-text rendering of an account.
pub fn render_me(me: &Me) -> String {
    let mut text = format!("{} · {} ({})\n", me.id, me.display_name, me.kind.title());
    let mut rows = vec![
        ("uuid", me.uuid.clone()),
        ("status", me.status.clone()),
        ("timezone", me.timezone.clone()),
        ("dob", me.dob.map(|d| d.to_string()).unwrap_or_default()),
        ("photo", me.pfp_url.clone()),
        ("created", stamp(me.created_at)),
    ];
    match me.kind {
        AccountKind::Carbon => {
            let emails = me
                .emails
                .iter()
                .map(|e| {
                    if e.is_primary {
                        format!("{} (primary)", e.email)
                    } else {
                        e.email.clone()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            let phones = me
                .phones
                .iter()
                .map(|p| {
                    if p.is_primary {
                        format!("{} (primary)", p.phone)
                    } else {
                        p.phone.clone()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            let identities = me
                .identities
                .iter()
                .map(|i| i.provider.clone())
                .collect::<Vec<_>>()
                .join(", ");
            rows.push(("emails", emails));
            rows.push(("phones", phones));
            rows.push(("identities", identities));
            if let Some(count) = me.custodian_of {
                rows.push((
                    "custodian of",
                    format!("{count} Silicon{}", if count == 1 { "" } else { "s" }),
                ));
            }
        }
        AccountKind::Silicon => {
            let custodian = me
                .custodian
                .as_ref()
                .map(|c| match &c.display_name {
                    Some(name) if !name.is_empty() => format!("{} ({name})", c.id),
                    _ => c.id.clone(),
                })
                .unwrap_or_else(|| "none yet (waiting for the custodian to accept)".to_owned());
            rows.push(("custodian", custodian));
            rows.push(("webhook", me.webhook_url.clone().unwrap_or_default()));
            rows.push(("stk rotated", stamp(me.stk_rotated_at)));
        }
    }
    text.push_str(&kv(&rows));
    text
}

pub async fn whoami(ctx: &Ctx) -> CliResult<Outcome> {
    let me = with_session!(ctx, |s| s.me())?;
    let mut outcome = Outcome::new(to_json(&me), render_me(&me));
    outcome = match me.kind {
        AccountKind::Silicon => outcome.next(
            "accounts login --app <app_id>",
            "get a short-lived token for an app",
        ),
        AccountKind::Carbon => outcome
            .next(
                "accounts profile set --display-name <name>",
                "change your details",
            )
            .next("accounts silicon list", "the Silicons you are custodian of"),
    };
    Ok(outcome)
}

// ---- ids ---------------------------------------------------------------------------------

pub async fn id(ctx: &Ctx, args: IdArgs) -> CliResult<Outcome> {
    match args.command {
        IdCommand::Available { id } => {
            let session = ctx.current_session().ok().flatten();
            let availability = match session {
                Some(_) => match with_session!(ctx, |s| s.id_available(&id)) {
                    Ok(a) => a,
                    Err(err) if err.code == "session_ended" || err.code == "not_signed_in" => {
                        ctx.client()?.id_available(&id).await?
                    }
                    Err(err) => return Err(err),
                },
                None => ctx.client()?.id_available(&id).await?,
            };
            let shown = if availability.id.is_empty() {
                id.clone()
            } else {
                availability.id.clone()
            };
            let (text, exit) = if availability.available && availability.reclaimable {
                (
                    format!(
                        "{shown} is reserved for you after your id change: you can take it back."
                    ),
                    0,
                )
            } else if availability.available {
                (format!("{shown} is available."), 0)
            } else {
                let reason = availability
                    .reason
                    .clone()
                    .unwrap_or_else(|| "taken".to_owned());
                let message = availability.message.clone().unwrap_or_default();
                let exit = if reason == "invalid" {
                    EXIT_INVALID
                } else {
                    EXIT_CONFLICT
                };
                (
                    format!("{shown} is not available ({reason}). {message}")
                        .trim_end()
                        .to_owned(),
                    exit,
                )
            };
            let mut outcome = Outcome::new(to_json(&availability), text).exit(exit);
            if availability.available {
                outcome = outcome.next(format!("accounts id change {shown}"), "take it as your id");
            }
            Ok(outcome)
        }
        IdCommand::Change { new_id } => {
            let session = ctx.session().await?;
            let new_id = util::with_prefix(&new_id, session.kind);
            let old_id = session.account.id.clone();
            let me = with_session!(ctx, |s| s.change_id(&new_id))?;
            let mut stored = ctx.session().await?;
            stored.account.id.clone_from(&me.id);
            ctx.save_session(&stored)?;
            let text = format!(
                "Your id is now {}. {old_id} stays reserved for you for 10 days; apps you signed into were notified (they key on your uuid {}).",
                me.id, me.uuid
            );
            Ok(Outcome::new(to_json(&me), text).next("accounts whoami", "see your account"))
        }
    }
}

pub async fn lookup(ctx: &Ctx, target: &str) -> CliResult<Outcome> {
    let target = target.trim().to_owned();
    let account = if ctx.current_session()?.is_some() {
        with_session!(ctx, |s| s.resolve(&target))?
    } else {
        let selection = ctx.app_selection(None, None, false);
        match selection {
            Ok(selection) if selection.secret.is_some() => {
                let app = ctx.app_client(&selection).await?;
                app.resolve(&target).await?
            }
            _ => {
                let (url, _) = ctx.url()?;
                return Err(crate::ctx::not_signed_in(&url));
            }
        }
    };
    Ok(Outcome::new(to_json(&account), render_summary(&account)))
}

pub fn render_summary(account: &AccountSummary) -> String {
    let mut rows = vec![
        ("uuid", account.uuid.clone()),
        ("kind", account.kind.as_str().to_owned()),
        ("display name", account.display_name.clone()),
        ("status", account.status.clone()),
        ("photo", account.pfp_url.clone()),
    ];
    if let Some(custodian) = &account.custodian {
        rows.push(("custodian", custodian.id.clone()));
    }
    format!(
        "{}\n{}",
        if account.id.is_empty() {
            "(deleted account)"
        } else {
            &account.id
        },
        kv(&rows)
    )
}

// ---- profile -----------------------------------------------------------------------------

pub async fn profile(ctx: &Ctx, args: ProfileArgs) -> CliResult<Outcome> {
    match args.command {
        ProfileCommand::Show => whoami(ctx).await,
        ProfileCommand::Set(set) => profile_set(ctx, set).await,
    }
}

async fn profile_set(ctx: &Ctx, args: ProfileSetArgs) -> CliResult<Outcome> {
    let dob = match &args.dob {
        Some(text) => Some(parse_date(text)?),
        None => None,
    };
    let update = ProfileUpdate {
        display_name: args.display_name.clone(),
        timezone: args.timezone.clone(),
        dob,
        pfp_url: args.pfp_url.clone(),
    };
    if update.is_empty() && args.photo.is_none() && !args.reset_photo {
        return Err(CliError::invalid(
            "Nothing to change: pass at least one of --display-name, --timezone, --dob, --pfp-url, --photo or --reset-photo.",
            "See `accounts profile set --help`.",
        ));
    }
    let mut changed = Vec::new();
    if let Some(path) = &args.photo {
        let (bytes, content_type) = read_photo(path)?;
        let uploaded = with_session!(ctx, |s| s.set_photo(bytes.clone(), content_type))?;
        changed.push(format!("photo → {}", uploaded.pfp_url));
    }
    if args.reset_photo {
        with_session!(ctx, |s| s.remove_photo())?;
        changed.push("photo → default".to_owned());
    }
    let me = if update.is_empty() {
        with_session!(ctx, |s| s.me())?
    } else {
        let me = with_session!(ctx, |s| s.update_me(&update))?;
        if let Some(name) = &update.display_name {
            changed.push(format!("display name → {name}"));
            if let Ok(mut stored) = ctx.session().await {
                stored.account.display_name.clone_from(&me.display_name);
                ctx.save_session(&stored)?;
            }
        }
        if let Some(tz) = &update.timezone {
            changed.push(format!("timezone → {tz}"));
        }
        if let Some(dob) = &update.dob {
            changed.push(format!("dob → {dob}"));
        }
        if let Some(url) = &update.pfp_url {
            changed.push(format!("photo → {url}"));
        }
        me
    };
    let text = format!(
        "Updated: {}.\nApps that can see these fields were notified.\n\n{}",
        changed.join(", "),
        render_me(&me)
    );
    Ok(Outcome::new(to_json(&me), text))
}

fn parse_date(text: &str) -> CliResult<time::Date> {
    let format = time::macros::format_description!("[year]-[month]-[day]");
    time::Date::parse(text.trim(), &format).map_err(|_| {
        CliError::invalid(
            format!("`{text}` is not a date in YYYY-MM-DD form."),
            "Write it like 1999-04-01.",
        )
    })
}

fn read_photo(path: &Path) -> CliResult<(bytes::Bytes, &'static str)> {
    let bytes = util::read_file_or_stdin(path, "the photo")?;
    let content_type = match bytes.as_slice() {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [0xFF, 0xD8, 0xFF, ..] => "image/jpeg",
        [b'G', b'I', b'F', b'8', ..] => "image/gif",
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            ..,
        ] => "image/webp",
        _ => {
            return Err(CliError::invalid(
                format!("{} is not a PNG, JPEG, WebP or GIF image.", path.display()),
                "Convert it to one of those formats (at most 2 MB).",
            ));
        }
    };
    if bytes.len() > 2 * 1024 * 1024 {
        return Err(CliError::invalid(
            format!(
                "{} is {} bytes; profile photos are limited to 2 MB.",
                path.display(),
                bytes.len()
            ),
            "Resize or compress it below 2 MB.",
        ));
    }
    Ok((bytes::Bytes::from(bytes), content_type))
}

// ---- emails and phones -------------------------------------------------------------------

pub async fn email(ctx: &Ctx, args: EmailArgs) -> CliResult<Outcome> {
    ctx.session_of(AccountKind::Carbon, "Managing email addresses")
        .await?;
    let render = |emails: &[silicon_accounts_client::EmailAddress]| {
        let rows: Vec<Vec<String>> = emails
            .iter()
            .map(|e| {
                vec![
                    e.email.clone(),
                    if e.is_primary {
                        "primary".into()
                    } else {
                        String::new()
                    },
                    e.verified_via.clone().unwrap_or_default(),
                    stamp(e.verified_at),
                ]
            })
            .collect();
        table(
            &["EMAIL", "", "VERIFIED VIA", "VERIFIED AT"],
            &rows,
            "No email addresses.",
        )
    };
    match args.command {
        EmailCommand::List => {
            let emails = with_session!(ctx, |s| s.emails())?;
            Ok(
                Outcome::new(json!({ "emails": to_json(&emails) }), render(&emails))
                    .next("accounts email add <email>", "add another email (up to 10)"),
            )
        }
        EmailCommand::Add { email } => {
            let challenge = with_session!(ctx, |s| s.add_email(&email))?;
            if util::interactive(ctx.global.json) {
                let code = util::prompt(&format!(
                    "Enter the 6-digit code sent to {email} (or press Enter to verify later): "
                ))?;
                if !code.is_empty() {
                    let emails =
                        with_session!(ctx, |s| s.verify_email(&challenge.challenge_id, &code))?;
                    return Ok(Outcome::new(
                        json!({ "emails": to_json(&emails) }),
                        format!("Added {email}.\n\n{}", render(&emails)),
                    )
                    .next(
                        format!("accounts email primary {email}"),
                        "make it your primary email",
                    ));
                }
            }
            let verify = format!("accounts email verify {} <code>", challenge.challenge_id);
            let text = format!(
                "A 6-digit code was sent to {email}{}.\nConfirm it with:\n  {verify}",
                challenge
                    .expires_at
                    .map(|t| format!(" (valid until {})", when(Some(t))))
                    .unwrap_or_default()
            );
            Ok(Outcome::new(
                json!({ "status": "code_sent", "challenge_id": challenge.challenge_id, "email": email, "expires_at": crate::output::json_time(challenge.expires_at), "next": verify }),
                text,
            ))
        }
        EmailCommand::Verify { challenge_id, code } => {
            let emails = with_session!(ctx, |s| s.verify_email(&challenge_id, &code))?;
            Ok(Outcome::new(
                json!({ "emails": to_json(&emails) }),
                format!("Email verified and added.\n\n{}", render(&emails)),
            ))
        }
        EmailCommand::Primary { email } => {
            let emails = with_session!(ctx, |s| s.make_email_primary(&email))?;
            Ok(Outcome::new(
                json!({ "emails": to_json(&emails) }),
                format!(
                    "{email} is now your primary email; apps with the email scope were notified.\n\n{}",
                    render(&emails)
                ),
            ))
        }
        EmailCommand::Remove { email } => {
            let emails = with_session!(ctx, |s| s.remove_email(&email))?;
            Ok(Outcome::new(
                json!({ "emails": to_json(&emails) }),
                format!(
                    "Removed {email}; it can no longer sign you in.\n\n{}",
                    render(&emails)
                ),
            ))
        }
    }
}

pub async fn phone(ctx: &Ctx, args: PhoneArgs) -> CliResult<Outcome> {
    ctx.session_of(AccountKind::Carbon, "Managing phone numbers")
        .await?;
    let render = |phones: &[silicon_accounts_client::PhoneNumber]| {
        let rows: Vec<Vec<String>> = phones
            .iter()
            .map(|p| {
                vec![
                    p.phone.clone(),
                    if p.is_primary {
                        "primary".into()
                    } else {
                        String::new()
                    },
                    stamp(p.verified_at),
                ]
            })
            .collect();
        table(&["PHONE", "", "VERIFIED AT"], &rows, "No phone numbers.")
    };
    match args.command {
        PhoneCommand::List => {
            let phones = with_session!(ctx, |s| s.phones())?;
            Ok(
                Outcome::new(json!({ "phones": to_json(&phones) }), render(&phones)).next(
                    "accounts phone add <number>",
                    "add another number (up to 10)",
                ),
            )
        }
        PhoneCommand::Add { phone, country } => {
            let challenge = with_session!(ctx, |s| s.add_phone(&phone, country.as_deref()))?;
            if util::interactive(ctx.global.json) {
                let code = util::prompt(&format!(
                    "Enter the 6-digit code sent to {phone} (or press Enter to verify later): "
                ))?;
                if !code.is_empty() {
                    let phones =
                        with_session!(ctx, |s| s.verify_phone(&challenge.challenge_id, &code))?;
                    return Ok(Outcome::new(
                        json!({ "phones": to_json(&phones) }),
                        format!("Added {phone}.\n\n{}", render(&phones)),
                    ));
                }
            }
            let verify = format!("accounts phone verify {} <code>", challenge.challenge_id);
            let text =
                format!("A 6-digit code was sent by SMS to {phone}.\nConfirm it with:\n  {verify}");
            Ok(Outcome::new(
                json!({ "status": "code_sent", "challenge_id": challenge.challenge_id, "phone": phone, "expires_at": crate::output::json_time(challenge.expires_at), "next": verify }),
                text,
            ))
        }
        PhoneCommand::Verify { challenge_id, code } => {
            let phones = with_session!(ctx, |s| s.verify_phone(&challenge_id, &code))?;
            Ok(Outcome::new(
                json!({ "phones": to_json(&phones) }),
                format!("Phone number verified and added.\n\n{}", render(&phones)),
            ))
        }
        PhoneCommand::Primary { phone } => {
            let phones = with_session!(ctx, |s| s.make_phone_primary(&phone))?;
            Ok(Outcome::new(
                json!({ "phones": to_json(&phones) }),
                format!("{phone} is now your primary number.\n\n{}", render(&phones)),
            ))
        }
        PhoneCommand::Remove { phone } => {
            let phones = with_session!(ctx, |s| s.remove_phone(&phone))?;
            Ok(Outcome::new(
                json!({ "phones": to_json(&phones) }),
                format!("Removed {phone}.\n\n{}", render(&phones)),
            ))
        }
    }
}

pub async fn identities(ctx: &Ctx, args: IdentitiesArgs) -> CliResult<Outcome> {
    ctx.session_of(AccountKind::Carbon, "Linked identities")
        .await?;
    match args.command {
        IdentitiesCommand::List => {
            let list = with_session!(ctx, |s| s.identities())?;
            let rows: Vec<Vec<String>> = list
                .iter()
                .map(|i| {
                    vec![
                        i.provider.clone(),
                        i.subject.clone().unwrap_or_default(),
                        i.email.clone().unwrap_or_default(),
                        stamp(i.last_used_at),
                    ]
                })
                .collect();
            Ok(Outcome::new(
                json!({ "identities": to_json(&list) }),
                table(
                    &["PROVIDER", "SUBJECT", "EMAIL", "LAST USED"],
                    &rows,
                    "No linked Google or Apple identities.",
                ),
            ))
        }
        IdentitiesCommand::Remove { provider, subject } => {
            with_session!(ctx, |s| s.remove_identity(&provider, &subject))?;
            Ok(Outcome::new(
                json!({ "removed": true, "provider": provider, "subject": subject }),
                format!(
                    "Unlinked the {provider} identity {subject}; it can no longer sign you in."
                ),
            ))
        }
    }
}

// ---- apps, proofs, sessions, history -----------------------------------------------------

pub async fn my_apps(ctx: &Ctx, args: MyAppsArgs) -> CliResult<Outcome> {
    match args.command {
        MyAppsCommand::List => {
            let apps = with_session!(ctx, |s| s.apps())?;
            let rows: Vec<Vec<String>> = apps
                .iter()
                .map(|a| {
                    vec![
                        a.app.app_id.clone(),
                        a.app.name.clone(),
                        a.status.clone(),
                        a.granted_scopes.join(" "),
                        stamp(a.last_signed_in_at),
                    ]
                })
                .collect();
            Ok(Outcome::new(
                json!({ "items": to_json(&apps) }),
                table(
                    &["APP", "NAME", "STATUS", "SHARED", "LAST SIGN-IN"],
                    &rows,
                    "You haven't signed into any app yet.",
                ),
            )
            .next("accounts apps remove <app_id>", "remove an app's access"))
        }
        MyAppsCommand::Remove { app_id } => {
            with_session!(ctx, |s| s.remove_app_access(&app_id))?;
            Ok(Outcome::new(
                json!({ "removed": true, "app_id": app_id }),
                format!(
                    "Removed {app_id}'s access: its tokens for you and the OBO proofs it issued about you are revoked, and it was told (membership.access_removed)."
                ),
            ))
        }
    }
}

pub async fn my_proofs(ctx: &Ctx, args: MyProofsArgs) -> CliResult<Outcome> {
    match args.command {
        MyProofsCommand::List => {
            let proofs = with_session!(ctx, |s| s.proofs())?;
            let rows: Vec<Vec<String>> = proofs
                .iter()
                .map(|p| {
                    vec![
                        p.proof_id.clone(),
                        format!("{} → {}", p.issuing_app.app_id, p.receiving_app.app_id),
                        p.scopes.join(" "),
                        p.status.clone(),
                        stamp(p.expires_at),
                    ]
                })
                .collect();
            Ok(Outcome::new(
                json!({ "items": to_json(&proofs) }),
                table(
                    &["PROOF", "APPS", "SCOPES", "STATUS", "EXPIRES"],
                    &rows,
                    "No OBO proofs were issued on your behalf.",
                ),
            )
            .next("accounts proofs revoke <proof_id>", "revoke one"))
        }
        MyProofsCommand::Revoke { proof_id } => {
            with_session!(ctx, |s| s.revoke_proof(&proof_id))?;
            Ok(Outcome::new(
                json!({ "revoked": true, "proof_id": proof_id }),
                format!("Revoked proof {proof_id}; it no longer verifies."),
            ))
        }
    }
}

pub async fn sessions(ctx: &Ctx, args: SessionsArgs) -> CliResult<Outcome> {
    match args.command {
        SessionsCommand::List => {
            let list = with_session!(ctx, |s| s.sessions())?;
            let rows: Vec<Vec<String>> = list
                .iter()
                .map(|s| {
                    vec![
                        s.id.clone(),
                        s.kind.clone(),
                        format!(
                            "{}{}",
                            s.label.clone().unwrap_or_default(),
                            if s.current { " (this one)" } else { "" }
                        ),
                        s.ip.clone().unwrap_or_default(),
                        stamp(s.last_seen_at),
                    ]
                })
                .collect();
            Ok(Outcome::new(
                json!({ "items": to_json(&list) }),
                table(
                    &["ID", "KIND", "LABEL", "IP", "LAST SEEN"],
                    &rows,
                    "No sessions.",
                ),
            )
            .next("accounts sessions revoke <id>", "sign a session out"))
        }
        SessionsCommand::Revoke { id } => {
            with_session!(ctx, |s| s.revoke_session(&id))?;
            Ok(Outcome::new(
                json!({ "revoked": true, "id": id }),
                format!("Revoked session {id}."),
            ))
        }
    }
}

pub async fn history(ctx: &Ctx, args: HistoryArgs) -> CliResult<Outcome> {
    let query = HistoryQuery {
        kind: args.kind.map(|k| k.as_str().to_owned()),
        limit: args.limit,
        cursor: args.cursor.clone(),
    };
    let page = with_session!(ctx, |s| s.history(&query))?;
    let rows: Vec<Vec<String>> = page
        .items
        .iter()
        .map(|h| {
            vec![
                stamp(h.at),
                h.kind.clone(),
                h.title.clone(),
                h.app.as_ref().map(|a| a.app_id.clone()).unwrap_or_default(),
            ]
        })
        .collect();
    let mut text = table(&["WHEN", "KIND", "WHAT", "APP"], &rows, "No history yet.");
    let mut outcome_next = None;
    if let Some(cursor) = &page.next_cursor {
        text.push_str(&format!("\nMore: accounts history --cursor {cursor}\n"));
        outcome_next = Some(cursor.clone());
    }
    let mut outcome = Outcome::new(to_json(&page), text);
    if let Some(cursor) = outcome_next {
        outcome = outcome.next(
            format!("accounts history --cursor {cursor}"),
            "the next page",
        );
    }
    Ok(outcome)
}

pub async fn delete_account(ctx: &Ctx, args: DeleteAccountArgs) -> CliResult<Outcome> {
    let session = ctx.session().await?;
    let confirm = match args.confirm {
        Some(confirm) => confirm,
        None if util::interactive(ctx.global.json) => util::prompt(&format!(
            "This permanently deletes {} ({}). Type its id to confirm: ",
            session.who(),
            session.kind.title()
        ))?,
        None => {
            return Err(CliError::invalid(
                "Deleting an account needs --confirm <your id>.",
                format!("Run `accounts delete-account --confirm {}`.", session.who()),
            ));
        }
    };
    if confirm.trim().to_ascii_lowercase() != session.account.id {
        return Err(CliError::invalid(
            format!(
                "--confirm `{confirm}` does not match your id {}.",
                session.who()
            ),
            format!("Pass exactly {}.", session.who()),
        ));
    }
    with_session!(ctx, |s| s.delete_account(&confirm))?;
    ctx.clear_session()?;
    Ok(Outcome::new(
        json!({ "deleted": true, "id": session.account.id, "uuid": session.account.uuid }),
        format!(
            "Deleted {}. Apps you signed into were told; your id is held for 10 days.",
            session.who()
        ),
    ))
}

pub async fn device(ctx: &Ctx, args: DeviceArgs) -> CliResult<Outcome> {
    ctx.session_of(AccountKind::Carbon, "Approving CLI sign-ins")
        .await?;
    match args.command {
        DeviceCommand::Show { code } => {
            let request = with_session!(ctx, |s| s.device_request(&code))?;
            let text = kv(&[
                ("code", request.user_code.clone()),
                ("label", request.client_label.clone().unwrap_or_default()),
                ("status", request.status.clone()),
                ("expires", when(request.expires_at)),
            ]);
            Ok(Outcome::new(to_json(&request), text).next(
                format!("accounts device approve {}", request.user_code),
                "sign that machine in as you",
            ))
        }
        DeviceCommand::Approve { code } => {
            with_session!(ctx, |s| s.approve_device(&code))?;
            Ok(Outcome::new(
                json!({ "approved": true, "user_code": code }),
                format!("Approved {code}: that CLI is now signed in as you."),
            ))
        }
        DeviceCommand::Deny { code } => {
            with_session!(ctx, |s| s.deny_device(&code))?;
            Ok(Outcome::new(
                json!({ "denied": true, "user_code": code }),
                format!("Denied {code}."),
            ))
        }
    }
}
