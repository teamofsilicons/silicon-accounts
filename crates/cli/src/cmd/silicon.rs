//! Silicon commands: create (custodian or self), custodian management, requests, the
//! Silicon's own webhook, and custodian requests addressed to a Carbon.

use std::time::Duration;

use serde_json::{Value, json};
use silicon_accounts_client::{
    AccountKind, AccountsClient, CreateSilicon, CustodianRequestStatus, DeliveriesQuery,
    ManagedSilicon, PageRequest, SiliconSelfCreate, UpdateSilicon, WaitEvent, WaitOptions,
};
use time::OffsetDateTime;

use crate::cli::{
    CustodianArgs, CustodianCommand, DeliveriesFilter, OwnWebhookArgs, OwnWebhookCommand,
    RequestCommand, SiliconAppsCommand, SiliconArgs, SiliconAudiencesCommand, SiliconCommand,
    SiliconCreateArgs, SiliconKeysCommand, SiliconTrustCommand, SiliconWebhookCommand,
};
use crate::cmd::app::{deliveries_outcome, delivery_outcome, replay_outcome, replay_request};
use crate::ctx::{Ctx, StoredRequest, UrlSource};
use crate::error::{CliError, CliResult, EXIT_FAILURE, EXIT_INTERRUPTED, EXIT_NOT_FOUND};
use crate::home;
use crate::output::{Outcome, json_time, kv, stamp, table, to_json, when};
use crate::util;
use crate::with_session;

pub async fn silicon(ctx: &Ctx, args: SiliconArgs) -> CliResult<Outcome> {
    match args.command {
        SiliconCommand::Create(create_args) => create(ctx, create_args).await,
        SiliconCommand::List => list(ctx).await,
        SiliconCommand::Show { silicon } => {
            let managed = resolve(ctx, &silicon).await?;
            Ok(
                Outcome::new(to_json(&managed), render_managed(&managed)).next(
                    format!("silicon-accounts silicon rotate-stk {}", managed.silicon.id),
                    "issue a new STK",
                ),
            )
        }
        SiliconCommand::Update {
            silicon,
            display_name,
            timezone,
            pfp_url,
            photo,
        } => {
            let update = UpdateSilicon {
                display_name,
                timezone,
                pfp_url,
            };
            if update.is_empty() && photo.is_none() {
                return Err(CliError::invalid(
                    "Nothing to change: pass at least one of --display-name, --timezone, --pfp-url or --photo.",
                    "See `silicon-accounts silicon update --help`.",
                ));
            }
            let managed = resolve(ctx, &silicon).await?;
            let uuid = managed.silicon.uuid.clone();
            let mut updated = managed.silicon.clone();
            if let Some(path) = &photo {
                let (bytes, content_type) = super::account::read_photo(path)?;
                let key = util::idempotency_key();
                let uploaded = with_session!(ctx, |s| s.set_silicon_photo(
                    &uuid,
                    bytes.clone(),
                    content_type,
                    Some(&key)
                ))?;
                if let Some(after) = uploaded.silicon {
                    updated = after.silicon;
                } else {
                    updated.pfp_url = uploaded.pfp_url;
                }
            }
            if !update.is_empty() {
                updated = with_session!(ctx, |s| s.update_silicon(&uuid, &update))?;
            }
            Ok(Outcome::new(
                to_json(&updated),
                format!(
                    "Updated {}.\n\n{}",
                    updated.id,
                    super::account::render_me(&updated)
                ),
            ))
        }
        SiliconCommand::Id { silicon, new_id } => {
            let managed = resolve(ctx, &silicon).await?;
            let new_id = util::with_prefix(&new_id, AccountKind::Silicon);
            let uuid = managed.silicon.uuid.clone();
            let updated = with_session!(ctx, |s| s.change_silicon_id(&uuid, &new_id))?;
            Ok(Outcome::new(
                to_json(&updated),
                format!(
                    "{} is now {}. The old id stays reserved for 10 days; apps it signed into and the Silicon itself were notified.",
                    managed.silicon.id, updated.id
                ),
            ))
        }
        SiliconCommand::RotateStk {
            silicon,
            stk,
            stk_stdin,
        } => {
            let managed = resolve(ctx, &silicon).await?;
            let chosen = chosen_stk(ctx, stk, stk_stdin)?;
            let uuid = managed.silicon.uuid.clone();
            let rotated = with_session!(ctx, |s| s.rotate_stk(&uuid, chosen.as_deref()))?;
            let stk_text = match &rotated.stk {
                Some(stk) => format!("\nNew STK (shown once, store it now): {}\n", stk.expose()),
                None => "\nThe STK you chose is now active.\n".to_owned(),
            };
            let text = format!(
                "Rotated the STK of {}. The old STK no longer works and all its sessions (including apps') were revoked.{stk_text}",
                managed.silicon.id
            );
            Ok(Outcome::new(
                json!({ "silicon": managed.silicon.id, "uuid": uuid, "stk": rotated.stk.as_ref().map(|s| s.expose()), "rotated_at": json_time(rotated.rotated_at) }),
                text,
            )
            .next(format!("silicon-accounts login --silicon {} --stk-stdin", managed.silicon.id), "the Silicon signs in with the new STK"))
        }
        SiliconCommand::Webhook(webhook) => match webhook.command {
            SiliconWebhookCommand::Set { silicon, endpoint } => {
                let managed = resolve(ctx, &silicon).await?;
                let uuid = managed.silicon.uuid.clone();
                let hook = with_session!(ctx, |s| s.set_silicon_webhook(&uuid, &endpoint))?;
                Ok(Outcome::new(
                    to_json(&hook),
                    webhook_text(&managed.silicon.id, &hook),
                ))
            }
            SiliconWebhookCommand::Remove { silicon } => {
                let managed = resolve(ctx, &silicon).await?;
                let uuid = managed.silicon.uuid.clone();
                with_session!(ctx, |s| s.remove_silicon_webhook(&uuid))?;
                Ok(Outcome::new(
                    json!({ "removed": true, "silicon": managed.silicon.id }),
                    format!("Removed the webhook of {}.", managed.silicon.id),
                ))
            }
            SiliconWebhookCommand::Deliveries { silicon, filter } => {
                let managed = resolve(ctx, &silicon).await?;
                let uuid = managed.silicon.uuid.clone();
                let query = deliveries_query(filter);
                let page = with_session!(ctx, |s| s.silicon_webhook_deliveries(&uuid, &query))?;
                Ok(deliveries_outcome(
                    &page,
                    &format!(
                        "silicon-accounts silicon webhook replay {} --failed",
                        managed.silicon.id
                    ),
                ))
            }
            SiliconWebhookCommand::Delivery { silicon, id } => {
                let managed = resolve(ctx, &silicon).await?;
                let uuid = managed.silicon.uuid.clone();
                let detail = with_session!(ctx, |s| s.silicon_webhook_delivery(&uuid, &id))?;
                Ok(delivery_outcome(&detail))
            }
            SiliconWebhookCommand::Replay { silicon, selection } => {
                let managed = resolve(ctx, &silicon).await?;
                let uuid = managed.silicon.uuid.clone();
                let request =
                    replay_request(selection.ids, selection.failed, selection.since.as_deref())?;
                let key = selection
                    .idempotency_key
                    .unwrap_or_else(util::idempotency_key);
                let result = with_session!(ctx, |s| s.replay_silicon_webhook(
                    &uuid,
                    &request,
                    Some(&key)
                ))?;
                let id = &managed.silicon.id;
                Ok(replay_outcome(
                    &result,
                    &format!("Webhook of {id}"),
                    &format!("silicon-accounts silicon webhook replay {id} --failed"),
                    &format!("silicon-accounts silicon webhook deliveries {id} --status pending"),
                ))
            }
        },
        SiliconCommand::Apps(apps) => silicon_apps(ctx, apps.command).await,
        SiliconCommand::Keys(keys) => silicon_keys(ctx, keys.command).await,
        SiliconCommand::Trust(trust) => silicon_trust(ctx, trust.command).await,
        SiliconCommand::Audiences(audiences) => silicon_audiences(ctx, audiences.command).await,
        SiliconCommand::Signins {
            silicon,
            limit,
            cursor,
        } => {
            let key = silicon.trim().to_string();
            let page = with_session!(ctx, |s| s.silicon_signins(
                &key,
                &PageRequest {
                    limit,
                    cursor: cursor.clone()
                }
            ))?;
            let rows: Vec<Vec<String>> = page
                .items
                .iter()
                .map(|i| {
                    vec![
                        i.at.clone(),
                        i.app
                            .as_ref()
                            .map_or_else(|| "Silicon Accounts".to_string(), |a| a.app_id.clone()),
                        i.method.clone(),
                        i.outcome.clone(),
                        i.ip.clone().unwrap_or_default(),
                    ]
                })
                .collect();
            let mut text = table(
                &["AT", "APP", "METHOD", "OUTCOME", "ADDRESS"],
                &rows,
                &format!("{key} has no sign-ins yet."),
            );
            if let Some(next) = &page.next_cursor {
                text.push_str(&format!("\nMore: --cursor {next}"));
            }
            Ok(Outcome::new(to_json(&page), text))
        }
        SiliconCommand::Transfer { silicon, to } => {
            let managed = resolve(ctx, &silicon).await?;
            let uuid = managed.silicon.uuid.clone();
            let request = with_session!(ctx, |s| s.transfer_silicon(&uuid, &to))?;
            let text = format!(
                "Asked {to} to become the custodian of {} (request {}). Nothing changes until they accept{}.",
                managed.silicon.id,
                request.id,
                request
                    .expires_at
                    .map(|t| format!(", by {}", when(Some(t))))
                    .unwrap_or_default()
            );
            Ok(Outcome::new(to_json(&request), text).next(
                format!(
                    "silicon-accounts silicon cancel-transfer {}",
                    managed.silicon.id
                ),
                "withdraw the request",
            ))
        }
        SiliconCommand::CancelTransfer { silicon } => {
            let managed = resolve(ctx, &silicon).await?;
            let uuid = managed.silicon.uuid.clone();
            with_session!(ctx, |s| s.cancel_transfer(&uuid))?;
            Ok(Outcome::new(
                json!({ "cancelled": true, "silicon": managed.silicon.id }),
                format!("Cancelled the pending transfer of {}.", managed.silicon.id),
            ))
        }
        SiliconCommand::Delete { silicon, confirm } => {
            let managed = resolve(ctx, &silicon).await?;
            let id = managed.silicon.id.clone();
            let confirm = match confirm {
                Some(c) => c,
                None if util::interactive(ctx.global.json) => util::prompt(&format!(
                    "This permanently deletes {id}. Type {id} to confirm: "
                ))?,
                None => {
                    return Err(CliError::invalid(
                        format!("Deleting {id} needs --confirm {id}."),
                        format!("Run `silicon-accounts silicon delete {id} --confirm {id}`."),
                    ));
                }
            };
            if util::with_prefix(&confirm, AccountKind::Silicon) != id {
                return Err(CliError::invalid(
                    format!("--confirm `{confirm}` does not match {id}."),
                    format!("Pass exactly {id}."),
                ));
            }
            let uuid = managed.silicon.uuid.clone();
            with_session!(ctx, |s| s.delete_silicon(&uuid, &id))?;
            Ok(Outcome::new(
                json!({ "deleted": true, "silicon": id, "uuid": uuid }),
                format!("Deleted {id}. Apps it signed into were told; its id is held for 10 days."),
            ))
        }
        SiliconCommand::Request(request) => match request.command {
            RequestCommand::Status {
                request_id,
                wait,
                timeout,
                token,
            } => request_status(ctx, &request_id, wait, timeout, token).await,
        },
    }
}

fn webhook_text(id: &str, hook: &silicon_accounts_client::SiliconWebhook) -> String {
    let secret = hook
        .webhook_secret
        .as_ref()
        .map(|s| {
            format!(
                "\nSigning secret (shown once, store it now): {}\n",
                s.expose()
            )
        })
        .unwrap_or_default();
    format!(
        "Webhook of {id} set to {}.{secret}Verify every delivery's X-Accounts-Signature with it (`silicon-accounts docs webhooks`).",
        hook.webhook_url
    )
}

fn chosen_stk(ctx: &Ctx, stk: Option<String>, stk_stdin: bool) -> CliResult<Option<String>> {
    match (stk, stk_stdin) {
        (Some(stk), _) => {
            ctx.out.warn("Passing an STK as an argument exposes it to other processes and your shell history; prefer --stk-stdin.");
            Ok(Some(util::normalize_stk(&stk)?))
        }
        (None, true) => Ok(Some(util::normalize_stk(&util::read_secret_stdin(
            "the STK",
        )?)?)),
        (None, false) => Ok(None),
    }
}

/// Finds one of my Silicons by si:id or uuid.
async fn resolve(ctx: &Ctx, target: &str) -> CliResult<ManagedSilicon> {
    ctx.session_of(AccountKind::Carbon, "Managing Silicons")
        .await?;
    let silicons = with_session!(ctx, |s| s.silicons())?;
    let target = target.trim();
    let as_id = util::with_prefix(target, AccountKind::Silicon);
    if let Some(found) = silicons
        .iter()
        .find(|m| m.silicon.uuid == target || m.silicon.id == as_id)
    {
        return Ok(found.clone());
    }
    let mine = silicons
        .iter()
        .map(|m| m.silicon.id.as_str())
        .collect::<Vec<_>>();
    let listing = if mine.is_empty() {
        "none".to_owned()
    } else {
        mine.join(", ")
    };
    Err(CliError::new(
        EXIT_NOT_FOUND,
        "not_found",
        format!("{target} is not one of your Silicons (you are custodian of: {listing})."),
        "Only a Silicon's custodian can manage it. Check the id with `silicon-accounts silicon list`, or ask its custodian.",
    ))
}

fn render_managed(managed: &ManagedSilicon) -> String {
    let mut text = super::account::render_me(&managed.silicon);
    if let Some(transfer) = &managed.pending_transfer {
        let to = transfer
            .to
            .as_ref()
            .map(|v| {
                v.get("id")
                    .and_then(Value::as_str)
                    .map_or_else(|| v.to_string(), str::to_owned)
            })
            .unwrap_or_default();
        text.push_str(&format!(
            "pending transfer to {to}, expires {}\n",
            when(transfer.expires_at)
        ));
    }
    text
}

async fn list(ctx: &Ctx) -> CliResult<Outcome> {
    ctx.session_of(AccountKind::Carbon, "Listing your Silicons")
        .await?;
    let silicons = with_session!(ctx, |s| s.silicons())?;
    let rows: Vec<Vec<String>> = silicons
        .iter()
        .map(|m| {
            let transfer = m
                .pending_transfer
                .as_ref()
                .map(|_| "transfer pending")
                .unwrap_or_default();
            vec![
                m.silicon.id.clone(),
                m.silicon.display_name.clone(),
                m.silicon.status.clone(),
                transfer.to_owned(),
                m.silicon.uuid.clone(),
            ]
        })
        .collect();
    Ok(Outcome::new(
        json!({ "items": to_json(&silicons) }),
        table(
            &["SILICON", "NAME", "STATUS", "", "UUID"],
            &rows,
            "You are not custodian of any Silicon yet.",
        ),
    )
    .next(
        "silicon-accounts silicon create --id si:<name>",
        "create one",
    )
    .next(
        "silicon-accounts custodian requests",
        "Silicons asking you to be their custodian",
    ))
}

// ---- create ------------------------------------------------------------------------------

async fn create(ctx: &Ctx, args: SiliconCreateArgs) -> CliResult<Outcome> {
    let id = util::with_prefix(&args.id, AccountKind::Silicon);
    if !id.starts_with("si:") {
        return Err(CliError::invalid(
            format!("`{id}` is not a Silicon id: Silicon ids start with si: (e.g. si:scout)."),
            "Pass --id si:<handle> (3 to 30 of a-z, 0-9, - and _).",
        ));
    }
    let display_name = args
        .display_name
        .clone()
        .unwrap_or_else(|| util::display_name_from_id(&id));
    let stk = chosen_stk(ctx, args.stk.clone(), args.stk_stdin)?;
    let timezone = args.timezone.clone().or_else(util::local_timezone);
    let key = args
        .idempotency_key
        .clone()
        .unwrap_or_else(util::idempotency_key);

    let carbon = if args.self_create {
        None
    } else {
        match ctx.current_session()? {
            Some(s) if s.kind == AccountKind::Carbon => Some(ctx.session().await?),
            _ => None,
        }
    };

    if let Some(session) = carbon {
        if let Some(custodian) = &args.custodian {
            let wanted = custodian.trim().to_ascii_lowercase();
            let is_me = if wanted.contains('@') {
                let me = with_session!(ctx, |s| s.me())?;
                me.emails.iter().any(|e| e.email == wanted)
            } else {
                util::with_prefix(&wanted, AccountKind::Carbon) == session.account.id
            };
            if !is_me {
                return Err(CliError::invalid(
                    format!(
                        "You are signed in as Carbon {}, so a Silicon you create gets you as its custodian, not {custodian}.",
                        session.who()
                    ),
                    format!(
                        "To have {custodian} as custodian, add --self-create (the Silicon's own request, which {custodian} must accept), or let {custodian} create it."
                    ),
                ));
            }
        }
        if args.wait {
            ctx.out.notice("Note: --wait only applies when a Silicon creates its own account; this one is active right away.");
        }
        let request = CreateSilicon {
            id: id.clone(),
            display_name,
            timezone,
            pfp_url: args.pfp_url.clone(),
            stk: stk.clone(),
            webhook_url: args.webhook.clone(),
        };
        let created = with_session!(ctx, |s| s.create_silicon(&request, Some(&key)))?;
        ctx.telemetry
            .step("silicon.create.custodian", 1.0, json!({}));
        let mut text = format!(
            "Created {} ({}) with you, {}, as its custodian. It can sign in right away.\n",
            created.silicon.id,
            created.silicon.uuid,
            session.who()
        );
        if let Some(generated) = &created.stk {
            text.push_str(&format!(
                "\nSTK (shown once, store it now): {}\n",
                generated.expose()
            ));
        }
        if let Some(secret) = &created.webhook_secret {
            text.push_str(&format!(
                "Webhook signing secret (shown once): {}\n",
                secret.expose()
            ));
        }
        return Ok(Outcome::new(to_json(&created), text)
            .next(
                format!(
                    "silicon-accounts login --silicon {} --stk-stdin",
                    created.silicon.id
                ),
                "how the Silicon signs in",
            )
            .next(
                format!("silicon-accounts silicon show {}", created.silicon.id),
                "see it",
            ));
    }

    let Some(custodian) = args.custodian.clone() else {
        return Err(CliError::invalid(
            "A Silicon creating its own account must name its custodian.",
            "Pass --custodian c:<id> or --custodian <email>. If you are a Carbon creating it for yourself, sign in first with `silicon-accounts login`.",
        ));
    };
    let request = SiliconSelfCreate {
        id: id.clone(),
        display_name,
        custodian: custodian.trim().to_owned(),
        timezone,
        pfp_url: args.pfp_url.clone(),
        stk: stk.clone(),
        webhook_url: args.webhook.clone(),
    };
    let client = ctx.client()?;
    let created = client.silicon_self_create(&request, Some(&key)).await?;
    ctx.telemetry.step(
        "silicon.create.requested",
        0.3,
        json!({ "wait": args.wait, "webhook": args.webhook.is_some() }),
    );
    let (url, _) = ctx.url()?;
    let stored = StoredRequest {
        request_id: created.request.id.clone(),
        request_token: created.request_token.expose().to_owned(),
        silicon_uuid: created.silicon.uuid.clone(),
        silicon_id: created.silicon.id.clone(),
        custodian: created.request.custodian.clone(),
        expires_at: created.request.expires_at,
        url,
        created_at: OffsetDateTime::now_utc(),
    };
    let request_path = request_file(ctx, &created.request.id)?;
    home::write_json(&request_path, &stored)?;

    let mut created_json = to_json(&created);
    created_json["request_file"] = json!(request_path.display().to_string());
    let mut summary = format!(
        "Created {} ({}). It can sign in once {} accepts being its custodian.\nCustodian request {} expires {}.\n",
        created.silicon.id,
        created.silicon.uuid,
        if created.request.custodian.is_empty() {
            custodian.as_str()
        } else {
            created.request.custodian.as_str()
        },
        created.request.id,
        when(created.request.expires_at)
    );
    if let Some(generated) = &created.stk {
        summary.push_str(&format!(
            "\nSTK (shown once, store it now): {}\n",
            generated.expose()
        ));
    }
    if let Some(secret) = &created.webhook_secret {
        summary.push_str(&format!(
            "Webhook signing secret (shown once): {}\n",
            secret.expose()
        ));
    }

    let status_cmd = format!(
        "silicon-accounts silicon request status {}",
        created.request.id
    );
    if !args.wait {
        summary.push_str(&format!(
            "\nThe request token is saved in {}.\n",
            request_path.display()
        ));
        return Ok(Outcome::new(created_json, summary)
            .next(
                format!("{status_cmd} --wait"),
                "wait for the custodian's decision",
            )
            .next(
                format!(
                    "silicon-accounts login --silicon {} --stk-stdin",
                    created.silicon.id
                ),
                "sign in once accepted",
            ));
    }

    // Show the STK now: the wait can take days and may be interrupted.
    if ctx.global.json {
        let mut event = created_json.clone();
        event["event"] = json!("silicon_created");
        ctx.out.essential("", &event);
    } else {
        crate::output::print_stdout(summary.trim_end());
    }
    let interrupted_details = created_json.clone();
    let final_status =
        wait_for_decision(ctx, client, &stored, args.timeout, interrupted_details).await?;
    let mut result = created_json;
    result["final_status"] = json!(final_status.status);
    result["decided_at"] = json_time(final_status.decided_at);
    // The creation response said `pending`; report the request and the Silicon as they are now.
    if let Some(request) = result.get_mut("request").and_then(Value::as_object_mut) {
        request.insert("status".into(), json!(final_status.status));
        request.insert("decided_at".into(), json_time(final_status.decided_at));
    }
    if !final_status.silicon.status.is_empty()
        && let Some(silicon) = result.get_mut("silicon").and_then(Value::as_object_mut)
    {
        silicon.insert("status".into(), json!(final_status.silicon.status));
    }

    if !final_status.is_accepted() {
        return Err(decision_error(&final_status, &stored));
    }
    let mut text = format!(
        "{} accepted: {} is active.\n",
        stored.custodian, stored.silicon_id
    );
    let login_stk = created.stk.as_ref().map(|s| s.expose().to_owned()).or(stk);
    let mut signed_in = false;
    if !args.no_login
        && let Some(stk) = login_stk
    {
        let existing = ctx.load_session()?;
        let other_account = existing
            .as_ref()
            .is_some_and(|s| s.account.uuid != stored.silicon_uuid);
        if other_account {
            text.push_str(&format!(
                "Not signing in as {} because this home is signed in as {}; run `silicon-accounts login --silicon {} --stk-stdin` where the Silicon runs.\n",
                stored.silicon_id,
                existing.as_ref().map_or("", |s| s.who()),
                stored.silicon_id
            ));
        } else {
            let label = util::client_label(None);
            let tokens = client
                .silicon_login(&stored.silicon_id, &stk, Some(&label))
                .await?;
            let session = ctx.store_tokens(&tokens, None, "silicon_stk")?;
            text.push_str(&format!("Signed in as {}.\n", session.who()));
            signed_in = true;
        }
    }
    result["signed_in"] = json!(signed_in);
    ctx.telemetry.step(
        "silicon.create.accepted",
        1.0,
        json!({ "signed_in": signed_in }),
    );
    Ok(Outcome::new(result, text).next(
        "silicon-accounts login --app <app_id>",
        "get a short-lived token for an app",
    ))
}

fn request_file(ctx: &Ctx, request_id: &str) -> CliResult<std::path::PathBuf> {
    if request_id.is_empty()
        || !request_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(CliError::invalid(
            format!("`{request_id}` is not a request id."),
            "Use the id printed by `silicon-accounts silicon create` (a UUID).",
        ));
    }
    Ok(ctx
        .home()?
        .state_dir()
        .join("requests")
        .join(format!("{request_id}.json")))
}

async fn wait_for_decision(
    ctx: &Ctx,
    client: &AccountsClient,
    stored: &StoredRequest,
    timeout: Duration,
    details: Value,
) -> CliResult<CustodianRequestStatus> {
    let options = WaitOptions::backoff(Duration::from_secs(5), Duration::from_secs(60))
        .with_timeout(Some(timeout));
    ctx.out.progress(&format!(
        "Waiting for {} to accept (checking every 5 s, slowing to 60 s; Ctrl-C stops waiting, the request stays open)…",
        stored.custodian
    ));
    let out = ctx.out;
    let wait = client.wait_for_custodian_decision(
        &stored.request_id,
        &stored.request_token,
        &options,
        |event| {
            if let WaitEvent::TransientError { error, retry_in } = event {
                out.warn(&format!(
                    "{} Retrying in {}s.",
                    error.message(),
                    retry_in.as_secs()
                ));
            }
        },
    );
    let resume = format!(
        "silicon-accounts silicon request status {} --wait",
        stored.request_id
    );
    tokio::select! {
        result = wait => match result {
            Ok(status) => Ok(status),
            Err(err) if err.code() == "timed_out" => Err(CliError::new(
                EXIT_FAILURE,
                "timed_out",
                format!("{} has not decided on {} yet (gave up after {}).", stored.custodian, stored.silicon_id, crate::output::relative(timeout.as_secs())),
                format!("The request stays open until it expires; resume with `{resume}`."),
            ).with_details(details)),
            Err(err) => Err(err.into()),
        },
        _ = tokio::signal::ctrl_c() => Err(CliError::new(
            EXIT_INTERRUPTED,
            "interrupted",
            format!("Stopped waiting for {} (the request is still open).", stored.custodian),
            format!("Resume with `{resume}`."),
        ).with_details(details)),
    }
}

fn decision_error(status: &CustodianRequestStatus, stored: &StoredRequest) -> CliError {
    let (code, message) = match status.status.as_str() {
        "declined" => (
            "custodian_declined",
            format!(
                "{} declined to be the custodian of {}. The account was released and {} is free again.",
                stored.custodian, stored.silicon_id, stored.silicon_id
            ),
        ),
        "expired" => (
            "custodian_request_expired",
            format!(
                "{} did not accept within 14 days, so the request expired and {} was released.",
                stored.custodian, stored.silicon_id
            ),
        ),
        "cancelled" => (
            "custodian_request_cancelled",
            format!(
                "The custodian request for {} was cancelled.",
                stored.silicon_id
            ),
        ),
        other => (
            "custodian_request_closed",
            format!(
                "The custodian request for {} ended with status `{other}`.",
                stored.silicon_id
            ),
        ),
    };
    CliError::new(EXIT_FAILURE, code, message, "Create the account again (`silicon-accounts silicon create`), naming a custodian who expects the request.")
        .with_details(to_json(status))
}

async fn request_status(
    ctx: &Ctx,
    request_id: &str,
    wait: bool,
    timeout: Duration,
    token: Option<String>,
) -> CliResult<Outcome> {
    let path = request_file(ctx, request_id)?;
    let stored: Option<StoredRequest> = home::read_json(&path)?;
    let token = match (token, &stored) {
        (Some(token), _) => util::arg_or_stdin(&token, "the request token")?,
        (None, Some(stored)) => stored.request_token.clone(),
        (None, None) => {
            return Err(CliError::invalid(
                format!(
                    "No request token for {request_id}: it was not created from this home ({}).",
                    path.display()
                ),
                "Pass --token sarq_… (printed when the Silicon was created), or run the command with the --home used then.",
            ));
        }
    };
    // A request lives at the URL it was created at, unless a URL was given explicitly.
    let (current_url, source) = ctx.url()?;
    let own_client;
    let client: &AccountsClient = match &stored {
        Some(stored)
            if stored.url != current_url && !matches!(source, UrlSource::Flag | UrlSource::Env) =>
        {
            own_client = AccountsClient::builder()
                .base_url(&stored.url)
                .user_agent(format!(
                    "silicon-accounts-cli/{}",
                    env!("CARGO_PKG_VERSION")
                ))
                .telemetry(ctx.telemetry_setting().0)
                .allow_insecure_http(true)
                .build()?;
            &own_client
        }
        _ => ctx.client()?,
    };
    let fallback = StoredRequest {
        request_id: request_id.to_owned(),
        request_token: token.clone(),
        silicon_uuid: String::new(),
        silicon_id: String::new(),
        custodian: "the custodian".to_owned(),
        expires_at: None,
        url: current_url,
        created_at: OffsetDateTime::now_utc(),
    };
    let mut known = stored.clone().unwrap_or(fallback);
    known.request_token = token;

    let status = if wait {
        let status = wait_for_decision(
            ctx,
            client,
            &known,
            timeout,
            json!({ "request_id": request_id }),
        )
        .await?;
        if !status.is_accepted() {
            if known.silicon_id.is_empty()
                && let Some(id) = &status.silicon.id
            {
                known.silicon_id.clone_from(id);
            }
            return Err(decision_error(&status, &known));
        }
        status
    } else {
        client
            .silicon_request_status(request_id, &known.request_token)
            .await?
    };
    let silicon_id = status
        .silicon
        .id
        .clone()
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| known.silicon_id.clone());
    let text = kv(&[
        ("request", status.id.clone()),
        ("silicon", format!("{silicon_id} ({})", status.silicon.uuid)),
        ("status", status.status.clone()),
        ("expires", when(status.expires_at)),
        ("decided", stamp(status.decided_at)),
    ]);
    let mut outcome = Outcome::new(to_json(&status), text);
    outcome = match status.status.as_str() {
        "accepted" => outcome.next(
            format!("silicon-accounts login --silicon {silicon_id} --stk-stdin"),
            "sign in",
        ),
        "pending" => outcome.next(
            format!("silicon-accounts silicon request status {request_id} --wait"),
            "wait for the decision",
        ),
        _ => outcome.next(
            "silicon-accounts silicon create --id si:<name> --custodian <c:id>",
            "start over with another custodian",
        ),
    };
    Ok(outcome)
}

// ---- a Silicon's own webhook -------------------------------------------------------------

pub async fn own_webhook(ctx: &Ctx, args: OwnWebhookArgs) -> CliResult<Outcome> {
    let session = ctx
        .session_of(AccountKind::Silicon, "A Silicon's own webhook")
        .await?;
    match args.command {
        OwnWebhookCommand::Set { endpoint } => {
            let hook = with_session!(ctx, |s| s.set_my_webhook(&endpoint))?;
            Ok(
                Outcome::new(to_json(&hook), webhook_text(session.who(), &hook))
                    .next("silicon-accounts webhook test", "send a test ping"),
            )
        }
        OwnWebhookCommand::Remove => {
            with_session!(ctx, |s| s.remove_my_webhook())?;
            Ok(Outcome::new(
                json!({ "removed": true }),
                "Removed your webhook; you won't be notified about your account anymore.",
            ))
        }
        OwnWebhookCommand::Test => {
            let result = with_session!(ctx, |s| s.test_my_webhook())?;
            Ok(Outcome::new(
                to_json(&result),
                format!(
                    "Queued a `ping` delivery{}.",
                    result
                        .event_id
                        .map(|id| format!(" (event {id})"))
                        .unwrap_or_default()
                ),
            )
            .next(
                "silicon-accounts webhook deliveries",
                "see whether it arrived",
            ))
        }
        OwnWebhookCommand::Deliveries { filter } => {
            let query = deliveries_query(filter);
            let page = with_session!(ctx, |s| s.my_webhook_deliveries(&query))?;
            Ok(deliveries_outcome(
                &page,
                "silicon-accounts webhook replay --failed",
            ))
        }
        OwnWebhookCommand::Delivery { id } => {
            let detail = with_session!(ctx, |s| s.my_webhook_delivery(&id))?;
            Ok(delivery_outcome(&detail))
        }
        OwnWebhookCommand::Replay { selection } => {
            let request =
                replay_request(selection.ids, selection.failed, selection.since.as_deref())?;
            let key = selection
                .idempotency_key
                .unwrap_or_else(util::idempotency_key);
            let result = with_session!(ctx, |s| s.replay_my_webhook(&request, Some(&key)))?;
            Ok(replay_outcome(
                &result,
                &format!("Webhook of {}", session.who()),
                "silicon-accounts webhook replay --failed",
                "silicon-accounts webhook deliveries --status pending",
            ))
        }
    }
}

fn deliveries_query(filter: DeliveriesFilter) -> DeliveriesQuery {
    DeliveriesQuery {
        status: filter.status,
        limit: filter.limit,
        cursor: filter.cursor,
    }
}

// ---- custodian requests (Carbons) --------------------------------------------------------

pub async fn custodian(ctx: &Ctx, args: CustodianArgs) -> CliResult<Outcome> {
    ctx.session_of(AccountKind::Carbon, "Custodian requests")
        .await?;
    match args.command {
        CustodianCommand::Requests => {
            let requests = with_session!(ctx, |s| s.custodian_requests())?;
            let rows: Vec<Vec<String>> = requests
                .iter()
                .map(|r| {
                    vec![
                        r.id.clone(),
                        r.kind.clone(),
                        r.silicon.as_ref().map(|s| s.id.clone()).unwrap_or_default(),
                        r.from.as_ref().map(|f| f.id.clone()).unwrap_or_default(),
                        stamp(r.expires_at),
                    ]
                })
                .collect();
            Ok(Outcome::new(
                json!({ "items": to_json(&requests) }),
                table(
                    &["REQUEST", "KIND", "SILICON", "FROM", "EXPIRES"],
                    &rows,
                    "No custodian requests are waiting for you.",
                ),
            )
            .next(
                "silicon-accounts custodian accept <request-id>",
                "become the custodian",
            )
            .next("silicon-accounts custodian decline <request-id>", "decline"))
        }
        CustodianCommand::Accept { id } => {
            with_session!(ctx, |s| s.accept_custodian_request(&id))?;
            Ok(Outcome::new(
                json!({ "accepted": true, "request_id": id }),
                format!("Accepted request {id}: you are now the custodian."),
            )
            .next(
                "silicon-accounts silicon list",
                "the Silicons you are custodian of",
            ))
        }
        CustodianCommand::Decline { id } => {
            with_session!(ctx, |s| s.decline_custodian_request(&id))?;
            Ok(Outcome::new(
                json!({ "declined": true, "request_id": id }),
                format!("Declined request {id}."),
            ))
        }
    }
}

async fn silicon_apps(ctx: &Ctx, command: SiliconAppsCommand) -> CliResult<Outcome> {
    match command {
        SiliconAppsCommand::List { silicon, status } => {
            let key = silicon.trim().to_string();
            let apps = with_session!(ctx, |s| s.silicon_apps(&key, status.as_deref()))?;
            let rows: Vec<Vec<String>> = apps
                .iter()
                .map(|a| {
                    vec![
                        a.app.app_id.clone(),
                        a.app.name.clone(),
                        a.status.clone(),
                        a.granted_scopes.join(" "),
                    ]
                })
                .collect();
            Ok(Outcome::new(
                json!({ "silicon": key, "items": to_json(&apps) }),
                table(
                    &["APP", "NAME", "STATUS", "SHARES"],
                    &rows,
                    &format!("{key} hasn't signed into any app."),
                ),
            ))
        }
        SiliconAppsCommand::Remove { silicon, app_id } => {
            let key = silicon.trim().to_string();
            with_session!(ctx, |s| s.remove_silicon_app(&key, &app_id))?;
            Ok(Outcome::new(
                json!({ "removed": true, "silicon": key, "app_id": app_id }),
                format!(
                    "Removed {key}'s access to {app_id}: its sign-ins there ended and the app was told."
                ),
            ))
        }
        SiliconAppsCommand::Allow {
            silicon,
            apps,
            any,
            none,
        } => {
            let key = silicon.trim().to_string();
            let list: Option<Vec<String>> = if any {
                None
            } else if none {
                Some(Vec::new())
            } else {
                Some(apps)
            };
            let allowed =
                with_session!(ctx, |s| s.set_silicon_allowed_apps(&key, list.as_deref()))?;
            Ok(Outcome::new(
                to_json(&allowed),
                allowed_text(&key, &allowed.allowed_apps),
            ))
        }
        SiliconAppsCommand::Allowed { silicon } => {
            let key = silicon.trim().to_string();
            let allowed = with_session!(ctx, |s| s.silicon_allowed_apps(&key))?;
            Ok(Outcome::new(
                to_json(&allowed),
                allowed_text(&key, &allowed.allowed_apps),
            ))
        }
    }
}

fn allowed_text(silicon: &str, allowed: &Option<Vec<String>>) -> String {
    match allowed {
        None => format!("{silicon} may get short-lived tokens for every app."),
        Some(list) if list.is_empty() => {
            format!("{silicon} may not get short-lived tokens for any app.")
        }
        Some(list) => format!(
            "{silicon} may get short-lived tokens only for: {}.",
            list.join(", ")
        ),
    }
}

async fn silicon_trust(ctx: &Ctx, command: SiliconTrustCommand) -> CliResult<Outcome> {
    use silicon_accounts_client::NewFederation;
    use silicon_accounts_client::federation::{GITHUB_ACTIONS_ISSUER, GITLAB_ISSUER};
    match command {
        SiliconTrustCommand::Add {
            silicon,
            github,
            gitlab,
            issuer,
            audience,
            claims,
            name,
        } => {
            let key = silicon.trim().to_string();
            let mut conditions = std::collections::BTreeMap::new();
            let issuer = if let Some(repo) = &github {
                conditions.insert("repository".to_string(), repo.trim().to_string());
                GITHUB_ACTIONS_ISSUER.to_string()
            } else if let Some(project) = &gitlab {
                conditions.insert("project_path".to_string(), project.trim().to_string());
                GITLAB_ISSUER.to_string()
            } else if let Some(issuer) = &issuer {
                issuer.trim().to_string()
            } else {
                return Err(CliError::invalid(
                    "Say which tokens to trust.",
                    "Pass --github owner/repo, --gitlab group/project, or --issuer <https URL> with at least one --claim name=value.",
                ));
            };
            for claim in &claims {
                let Some((name, value)) = claim.split_once('=') else {
                    return Err(CliError::invalid(
                        format!("--claim {claim} is not name=value."),
                        "Write each condition as --claim name=value, e.g. --claim ref=refs/heads/main.",
                    ));
                };
                conditions.insert(name.trim().to_string(), value.trim().to_string());
            }
            let new = NewFederation {
                issuer,
                audience: audience.map(|a| a.trim().to_string()),
                conditions,
                name,
            };
            let trust = with_session!(ctx, |s| s.add_federation(&key, &new))?;
            let conditions = trust
                .conditions
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join(", ");
            let text = format!(
                "{key} now trusts tokens from {} for the audience {} when {conditions} ({}).",
                trust.issuer, trust.audience, trust.id
            );
            let next = if trust.issuer == GITHUB_ACTIONS_ISSUER {
                format!("silicon-accounts login --silicon {key} --federated --github-actions")
            } else {
                format!("silicon-accounts login --silicon {key} --federated env:<VARIABLE>")
            };
            Ok(Outcome::new(to_json(&trust), text).next(next, "sign in from the CI job"))
        }
        SiliconTrustCommand::List { silicon } => {
            let key = silicon.trim().to_string();
            let trusts = with_session!(ctx, |s| s.federations(&key))?;
            let rows: Vec<Vec<String>> = trusts
                .iter()
                .map(|t| {
                    vec![
                        t.id.clone(),
                        t.issuer.clone(),
                        t.conditions
                            .iter()
                            .map(|(k, v)| format!("{k}={v}"))
                            .collect::<Vec<_>>()
                            .join(" "),
                        t.last_used_at.clone().unwrap_or_else(|| "never".into()),
                        if t.revoked_at.is_some() {
                            "removed".into()
                        } else {
                            "live".into()
                        },
                    ]
                })
                .collect();
            Ok(Outcome::new(
                json!({ "silicon": key, "items": to_json(&trusts) }),
                table(
                    &["TRUST", "ISSUER", "CONDITIONS", "LAST USED", "STATE"],
                    &rows,
                    &format!(
                        "{key} trusts no outside tokens: add one with `silicon-accounts silicon trust add {key} --github <owner/repo>`."
                    ),
                ),
            ))
        }
        SiliconTrustCommand::Remove { silicon, trust_id } => {
            let key = silicon.trim().to_string();
            with_session!(ctx, |s| s.remove_federation(&key, &trust_id))?;
            Ok(Outcome::new(
                json!({ "removed": true, "silicon": key, "trust_id": trust_id }),
                format!(
                    "Removed the trust {trust_id} of {key}: its tokens no longer sign in, and the sign-ins it started ended."
                ),
            ))
        }
    }
}

async fn silicon_audiences(ctx: &Ctx, command: SiliconAudiencesCommand) -> CliResult<Outcome> {
    let text = |key: &str, list: &[String]| {
        if list.is_empty() {
            format!("{key} may not get identity tokens for any outside service.")
        } else {
            format!("{key} may get identity tokens for: {}.", list.join(", "))
        }
    };
    match command {
        SiliconAudiencesCommand::List { silicon } => {
            let key = silicon.trim().to_string();
            let current = with_session!(ctx, |s| s.identity_audiences(&key))?;
            Ok(Outcome::new(
                to_json(&current),
                text(&key, &current.audiences),
            ))
        }
        SiliconAudiencesCommand::Allow { silicon, audiences } => {
            let key = silicon.trim().to_string();
            let current = with_session!(ctx, |s| s.identity_audiences(&key))?;
            let mut list = current.audiences.clone();
            for a in audiences {
                let a = a.trim().to_string();
                if !list.contains(&a) {
                    list.push(a);
                }
            }
            let updated = with_session!(ctx, |s| s.set_identity_audiences(&key, &list))?;
            Ok(
                Outcome::new(to_json(&updated), text(&key, &updated.audiences)).next(
                    "silicon-accounts token identity --audience <audience>",
                    "as the Silicon, get a token",
                ),
            )
        }
        SiliconAudiencesCommand::Remove {
            silicon,
            audiences,
            all,
        } => {
            let key = silicon.trim().to_string();
            let list: Vec<String> = if all {
                Vec::new()
            } else {
                let current = with_session!(ctx, |s| s.identity_audiences(&key))?;
                current
                    .audiences
                    .into_iter()
                    .filter(|a| !audiences.iter().any(|r| r.trim() == a))
                    .collect()
            };
            let updated = with_session!(ctx, |s| s.set_identity_audiences(&key, &list))?;
            Ok(Outcome::new(
                to_json(&updated),
                text(&key, &updated.audiences),
            ))
        }
    }
}

async fn silicon_keys(ctx: &Ctx, command: SiliconKeysCommand) -> CliResult<Outcome> {
    use silicon_accounts_client::SiliconSigningKey;
    match command {
        SiliconKeysCommand::Add {
            silicon,
            generate,
            private_key,
            public_key,
            name,
        } => {
            let key_silicon = silicon.trim().to_string();
            let (public, saved) = if let Some(path) = &generate {
                if path.exists() {
                    return Err(CliError::invalid(
                        format!(
                            "{} already exists; a new key never overwrites a file.",
                            path.display()
                        ),
                        "Choose another path, or register that key with --key.",
                    ));
                }
                let path = std::path::absolute(path).unwrap_or_else(|_| path.clone());
                let key = SiliconSigningKey::generate();
                let pem = key.to_pkcs8_pem()?;
                home::write_private(&path, pem.as_bytes())?;
                (key.public_key_base64url(), Some(path.display().to_string()))
            } else if let Some(path) = &private_key {
                (
                    SiliconSigningKey::from_file(path)?.public_key_base64url(),
                    None,
                )
            } else if let Some(given) = &public_key {
                let path = std::path::Path::new(given);
                let text = if path.is_file() {
                    std::fs::read_to_string(path).map_err(|e| CliError::io("read", path, &e))?
                } else {
                    given.clone()
                };
                (text.trim().to_string(), None)
            } else {
                return Err(CliError::invalid(
                    "Say which key to add.",
                    "Pass --generate <file> for a new key, --key <private key file>, or --public-key <file or key>.",
                ));
            };
            let info = with_session!(ctx, |s| s.add_silicon_key(
                &key_silicon,
                &public,
                name.as_deref()
            ))?;
            let mut text = format!(
                "Added the key {} ({}, {}) to {key_silicon}.",
                info.id, info.name, info.fingerprint
            );
            if let Some(path) = &saved {
                text.push_str(&format!(
                    "\nIts private half is in {path} (only you can read it); keep it there and back it up privately."
                ));
            }
            Ok(Outcome::new(to_json(&info), text).next(
                format!(
                    "silicon-accounts login --silicon {key_silicon} --key {}",
                    saved.as_deref().unwrap_or("<private key file>")
                ),
                "sign in with the key",
            ))
        }
        SiliconKeysCommand::List { silicon } => {
            let key_silicon = silicon.trim().to_string();
            let keys = with_session!(ctx, |s| s.silicon_keys(&key_silicon))?;
            let rows: Vec<Vec<String>> = keys
                .iter()
                .map(|k| {
                    vec![
                        k.id.clone(),
                        k.name.clone(),
                        k.fingerprint.clone(),
                        k.last_used_at.clone().unwrap_or_else(|| "never".into()),
                        if k.revoked_at.is_some() {
                            "revoked".into()
                        } else {
                            "live".into()
                        },
                    ]
                })
                .collect();
            Ok(Outcome::new(
                json!({ "silicon": key_silicon, "items": to_json(&keys) }),
                table(
                    &["KEY", "NAME", "FINGERPRINT", "LAST USED", "STATE"],
                    &rows,
                    &format!(
                        "{key_silicon} has no keys: add one with `silicon-accounts silicon keys add {key_silicon} --generate <file>`."
                    ),
                ),
            ))
        }
        SiliconKeysCommand::Revoke { silicon, key_id } => {
            let key_silicon = silicon.trim().to_string();
            with_session!(ctx, |s| s.revoke_silicon_key(&key_silicon, &key_id))?;
            Ok(Outcome::new(
                json!({ "revoked": true, "silicon": key_silicon, "key_id": key_id }),
                format!(
                    "Revoked the key {key_id} of {key_silicon}: it no longer signs in, and the sign-ins it started ended."
                ),
            ))
        }
    }
}
