//! App mode: `silicon-accounts app …`.

use std::io::Read;
use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use silicon_accounts_client::{
    APP_UPDATES, AppClient, AppDetails, DeliveriesQuery, DeliveryDetail, ImportInput, ImportJob,
    ImportOptions, ImportRowsQuery, IssueAppVerification, IssueUserVerification, MAX_IMPORT_BYTES,
    NewSubscription, Page, PageRequest, ProofRef, ProofVerification, ProofsQuery, ReplayRequest,
    ReplayResult, Subscription, SubscriptionChanges, SubscriptionDelivery, SubscriptionStatus,
    Updates, UsersQuery, WaitEvent, WaitOptions, WebhookDelivery,
};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::cli::{
    AppArgs, AppCommand, AppConfigCommand, AppSubscriptionCommand, AppWebhookCommand, DeliveryArg,
    ImportArgs, ImportCommand, ImportFormat, ProofCommand, TokenCommand,
};
use crate::ctx::{AppSelection, Ctx, StoredApp};
use crate::error::{CliError, CliResult, EXIT_FAILURE, EXIT_INVALID};
use crate::home;
use crate::output::{Outcome, kv, stamp, table, to_json, when};
use crate::util;

pub async fn app(ctx: &Ctx, args: AppArgs) -> CliResult<Outcome> {
    let AppArgs {
        app_id,
        app_secret,
        app_secret_stdin,
        command,
    } = args;
    match command {
        AppCommand::Use {
            app_id,
            secret_stdin,
            secret,
        } => use_app(ctx, &app_id, secret_stdin, secret).await,
        AppCommand::List => list_owned(ctx).await,
        AppCommand::New { no_browser } => new_app(ctx, no_browser).await,
        other => {
            let selection =
                ctx.app_selection(app_id.as_deref(), app_secret.as_deref(), app_secret_stdin)?;
            let app = ctx.app_client(&selection).await?;
            run_selected(ctx, &app, &selection, other).await
        }
    }
}

async fn run_selected(
    ctx: &Ctx,
    app: &AppClient<'_>,
    selection: &AppSelection,
    command: AppCommand,
) -> CliResult<Outcome> {
    let app_id = selection.app_id.clone();
    match command {
        AppCommand::Use {
            app_id,
            secret_stdin,
            secret,
        } => use_app(ctx, &app_id, secret_stdin, secret).await,
        AppCommand::List => list_owned(ctx).await,
        AppCommand::New { no_browser } => new_app(ctx, no_browser).await,
        AppCommand::Show => {
            let details = app.app().await?;
            let acting = match selection.secret_source {
                Some(source) => format!(
                    "app credentials (app id from {}, secret from {source})",
                    selection.id_source
                ),
                None => format!(
                    "owner session (app id from {}; no app secret)",
                    selection.id_source
                ),
            };
            let mut json = to_json(&details);
            json["acting_as"] = json!(acting);
            Ok(Outcome::new(
                json,
                format!("{}acting as     {acting}\n", render_app(&details)),
            )
            .next(
                "silicon-accounts app config get",
                "the full sign-in setup as JSON",
            )
            .next("silicon-accounts app users", "the user base"))
        }
        AppCommand::Config(config) => match config.command {
            AppConfigCommand::Get => {
                let details = app.app().await?;
                let json = json!({ "app_id": details.app_id, "config_version": details.config_version, "signin_config": to_json(&details.signin_config) });
                let pretty =
                    serde_json::to_string_pretty(&json["signin_config"]).unwrap_or_default();
                Ok(Outcome::new(
                    json,
                    format!(
                        "Sign-in setup of {} (version {}):\n{pretty}",
                        details.app_id, details.config_version
                    ),
                )
                .next(
                    format!(
                        "silicon-accounts app config set <patch.json> --expected-version {}",
                        details.config_version
                    ),
                    "change it",
                ))
            }
            AppConfigCommand::Set {
                file,
                expected_version,
                idempotency_key,
            } => {
                let bytes = util::read_file_or_stdin(&file, "the config patch")?;
                let patch: Value = serde_json::from_slice(&bytes).map_err(|e| {
                    CliError::invalid(
                        format!("{} is not valid JSON: {e}.", display_path(&file)),
                        "Pass a JSON object such as {\"methods\":{\"google\":true}}.",
                    )
                })?;
                if !patch.is_object() {
                    return Err(CliError::invalid(
                        "The config patch must be a JSON object (the settings to change).",
                        "Example: {\"required_fields\":[\"email\"],\"branding\":{\"radius\":12}}",
                    ));
                }
                // The version before the change: when nothing in the patch differs, the service
                // makes no new version and no history entry, and answers with the app as it is.
                let before = match expected_version {
                    Some(version) => version,
                    None => app.app().await?.config_version,
                };
                let key = idempotency_key.unwrap_or_else(util::idempotency_key);
                let details = app
                    .update_signin_config(&patch, expected_version, Some(&key))
                    .await?;
                let mut json = to_json(&details);
                if details.config_version == before {
                    json["changed"] = json!(false);
                    json["changes"] = json!([]);
                    return Ok(Outcome::new(
                        json,
                        format!(
                            "No change: {} already has these settings (the sign-in setup is still version {}).",
                            details.app_id, details.config_version
                        ),
                    )
                    .next("silicon-accounts app config get", "the full sign-in setup"));
                }
                // What changed: the history entry of this version (the paths that differ, not
                // every key of the patch).
                let entry = app
                    .signin_config_history(&PageRequest {
                        limit: Some(1),
                        cursor: None,
                    })
                    .await
                    .ok()
                    .and_then(|page| page.items.into_iter().next())
                    .filter(|entry| entry.version == details.config_version);
                let changed = entry
                    .as_ref()
                    .map(|entry| summarize_changes(&entry.changes))
                    .filter(|paths| !paths.is_empty())
                    .unwrap_or_else(|| {
                        patch
                            .as_object()
                            .map(|m| m.keys().cloned().collect::<Vec<_>>().join(", "))
                            .unwrap_or_default()
                    });
                json["changed"] = json!(true);
                json["changes"] = entry.map_or(Value::Null, |entry| entry.changes);
                Ok(Outcome::new(
                    json,
                    format!(
                        "Updated {} ({changed}); the sign-in setup is now version {}.",
                        details.app_id, details.config_version
                    ),
                )
                .next("silicon-accounts app config history", "see every change"))
            }
            AppConfigCommand::History { limit, cursor } => {
                let page = app
                    .signin_config_history(&PageRequest { limit, cursor })
                    .await?;
                let rows: Vec<Vec<String>> = page
                    .items
                    .iter()
                    .map(|h| {
                        vec![
                            h.version.to_string(),
                            h.actor_account
                                .as_ref()
                                .map(|a| a.id.clone())
                                .filter(|id| !id.is_empty())
                                .unwrap_or_else(|| h.actor.clone()),
                            stamp(h.at),
                            summarize_changes(&h.changes),
                        ]
                    })
                    .collect();
                Ok(Outcome::new(
                    to_json(&page),
                    with_more(
                        table(
                            &["VERSION", "BY", "AT", "CHANGES"],
                            &rows,
                            "No changes yet.",
                        ),
                        page.next_cursor.as_deref(),
                    ),
                ))
            }
        },
        AppCommand::Users(users) => {
            let query = UsersQuery {
                q: users.q,
                status: users.status,
                kind: users.kind,
                source: users.source,
                limit: users.limit,
                cursor: users.cursor,
            };
            let page = app.users(&query).await?;
            let rows: Vec<Vec<String>> = page
                .items
                .iter()
                .map(|u| {
                    vec![
                        u.uuid.clone(),
                        u.id.clone().unwrap_or_default(),
                        u.display_name.clone(),
                        u.status.clone(),
                        u.source.clone(),
                        u.email
                            .clone()
                            .or_else(|| u.phone.clone())
                            .unwrap_or_default(),
                        stamp(u.last_signed_in_at),
                    ]
                })
                .collect();
            Ok(Outcome::new(
                to_json(&page),
                with_more(
                    table(
                        &[
                            "UUID",
                            "ID",
                            "NAME",
                            "STATUS",
                            "SOURCE",
                            "CONTACT",
                            "LAST SIGN-IN",
                        ],
                        &rows,
                        "No accounts match.",
                    ),
                    page.next_cursor.as_deref(),
                ),
            )
            .next(
                "silicon-accounts app user <uuid>",
                "one account with its last sign-ins",
            ))
        }
        AppCommand::User { uuid } => {
            let user = app.user(&uuid).await?;
            let mut text = kv(&[
                ("membership", user.membership_id.clone()),
                ("id", user.id.clone().unwrap_or_default()),
                ("name", user.display_name.clone()),
                (
                    "kind",
                    user.kind.map(|k| k.as_str().to_owned()).unwrap_or_default(),
                ),
                ("status", user.status.clone()),
                ("source", user.source.clone()),
                ("external id", user.external_id.clone().unwrap_or_default()),
                ("email", user.email.clone().unwrap_or_default()),
                ("phone", user.phone.clone().unwrap_or_default()),
                ("scopes", user.granted_scopes.join(" ")),
                ("first sign-in", stamp(user.first_signed_in_at)),
                ("last sign-in", stamp(user.last_signed_in_at)),
            ]);
            if let Some(history) = &user.history {
                let rows: Vec<Vec<String>> = history
                    .iter()
                    .map(|h| {
                        vec![
                            stamp(h.at),
                            h.method.clone().unwrap_or_default(),
                            h.outcome.clone().unwrap_or_default(),
                        ]
                    })
                    .collect();
                text.push('\n');
                text.push_str(&table(
                    &["WHEN", "METHOD", "OUTCOME"],
                    &rows,
                    "No sign-ins yet.",
                ));
            }
            Ok(Outcome::new(to_json(&user), text))
        }
        AppCommand::Import(import) => run_import(ctx, app, import).await,
        AppCommand::Token(token) => run_token(app, token.command).await,
        AppCommand::Userinfo { access_token } => {
            let token = util::arg_or_stdin(&access_token, "the access token")?;
            let info = app.userinfo(&token).await?;
            let text = format!(
                "{} ({})\n{}",
                info.account.id,
                info.account.kind.as_str(),
                serde_json::to_string_pretty(&info).unwrap_or_default()
            );
            Ok(Outcome::new(to_json(&info), text))
        }
        AppCommand::Proof(proof) => run_proof(app, &app_id, proof.command).await,
        AppCommand::Webhook(webhook) => run_webhook(app, &app_id, webhook.command).await,
        AppCommand::Subscription(sub) => run_subscription(app, &app_id, sub.command).await,
        AppCommand::Lookup { target } => {
            let account = app.resolve(&target).await?;
            Ok(Outcome::new(
                to_json(&account),
                super::account::render_summary(&account),
            ))
        }
    }
}

fn display_path(path: &Path) -> String {
    if path == Path::new("-") {
        "stdin".to_owned()
    } else {
        path.display().to_string()
    }
}

fn with_more(mut text: String, cursor: Option<&str>) -> String {
    if let Some(cursor) = cursor {
        text.push_str(&format!("\nMore rows: add --cursor {cursor}\n"));
    }
    text
}

fn summarize_changes(changes: &Value) -> String {
    match changes {
        Value::Array(items) => items
            .iter()
            .filter_map(|c| c.get("path").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(", "),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn render_app(details: &AppDetails) -> String {
    let config = &details.signin_config;
    let mut rows = vec![
        ("app id", details.app_id.clone()),
        ("status", details.status.clone()),
        ("source", details.source.clone()),
        (
            "owner",
            details
                .owner
                .as_ref()
                .map(|o| o.id.clone())
                .unwrap_or_default(),
        ),
        ("methods", config.enabled_methods().join(", ")),
        ("required", config.required_fields.join(", ")),
        ("optional", config.optional_fields.join(", ")),
        ("redirect URIs", config.redirect_uris.join("\n")),
        ("allowed origins", config.allowed_origins.join("\n")),
        ("email domains", config.allowed_email_domains.join(", ")),
        (
            "sign up",
            config
                .allow_signup
                .map(|b| {
                    if b {
                        "allowed"
                    } else {
                        "existing accounts only"
                    }
                    .to_owned()
                })
                .unwrap_or_default(),
        ),
        ("config version", details.config_version.to_string()),
    ];
    if let Some(webhook) = &details.webhook {
        rows.push((
            "webhook",
            webhook.url.clone().unwrap_or_else(|| "not set".to_owned()),
        ));
    }
    if let Some(stats) = &details.stats {
        rows.push((
            "users",
            format!(
                "{} ({} active in 30 days, {} imported and unclaimed)",
                stats.users, stats.active_last_30d, stats.imported_unclaimed
            ),
        ));
    }
    format!("{} · {}\n{}", details.name, details.app_id, kv(&rows))
}

async fn use_app(
    ctx: &Ctx,
    app_id: &str,
    secret_stdin: bool,
    secret: Option<String>,
) -> CliResult<Outcome> {
    let app_id = app_id.trim().to_owned();
    let path = ctx.app_path(&app_id)?;
    let secret = match (secret, secret_stdin) {
        (Some(secret), _) => {
            ctx.out.warn("Passing a secret as an argument exposes it to other processes and your shell history; prefer --secret-stdin.");
            Some(secret.trim().to_owned())
        }
        (None, true) => Some(util::read_secret_stdin("the app secret")?),
        (None, false) => None,
    };
    let selection = AppSelection {
        app_id: app_id.clone(),
        id_source: "silicon-accounts app use",
        secret: secret.clone(),
        secret_source: secret.as_ref().map(|_| "--secret-stdin"),
    };
    let client = ctx.app_client(&selection).await?;
    let details = client.app().await?;
    let (url, _) = ctx.url()?;
    if secret.is_some() {
        home::write_json(
            &path,
            &StoredApp {
                app_id: app_id.clone(),
                app_secret: secret.clone(),
                url: Some(url),
                saved_at: OffsetDateTime::now_utc(),
            },
        )?;
    }
    let mut config = ctx.config()?.clone();
    config.app = Some(app_id.clone());
    ctx.save_config(&config)?;
    let how = if secret.is_some() {
        format!(
            "with its app secret (stored in {}, readable only by you)",
            path.display()
        )
    } else {
        "as its owner through your session (token exchange and proof issuing/verifying need the app secret: rerun with --secret-stdin)".to_owned()
    };
    Ok(Outcome::new(
        json!({ "app_id": app_id, "name": details.name, "mode": if secret.is_some() { "app_credentials" } else { "owner_session" }, "secret_file": secret.as_ref().map(|_| path.display().to_string()) }),
        format!("Using {} ({}) {how}.", details.app_id, details.name),
    )
    .next("silicon-accounts app show", "the app and its sign-in setup")
    .next("silicon-accounts app users", "its user base"))
}

async fn list_owned(ctx: &Ctx) -> CliResult<Outcome> {
    ctx.session_of(
        silicon_accounts_client::AccountKind::Carbon,
        "Listing the apps you own",
    )
    .await?;
    let apps = crate::with_session!(ctx, |s| s.owned_apps())?;
    let rows: Vec<Vec<String>> = apps
        .iter()
        .map(|a| {
            vec![
                a.app_id.clone(),
                a.name.clone(),
                a.status.clone(),
                a.users.to_string(),
                stamp(a.created_at),
            ]
        })
        .collect();
    Ok(Outcome::new(
        json!({ "items": to_json(&apps) }),
        table(
            &["APP", "NAME", "STATUS", "USERS", "CREATED"],
            &rows,
            "You don't own any app yet.",
        ),
    )
    .next("silicon-accounts app use <app_id>", "manage one")
    .next(
        "silicon-accounts app new",
        "make a new app (in Silicon Apps)",
    ))
}

async fn new_app(ctx: &Ctx, no_browser: bool) -> CliResult<Outcome> {
    let meta = ctx.client()?.meta().await?;
    let url = if meta.silicon_apps_url.is_empty() {
        "https://apps.teamofsilicons.com".to_owned()
    } else {
        meta.silicon_apps_url.clone()
    };
    let developer_url = meta
        .developer_url
        .clone()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| "https://developers.teamofsilicons.com".to_owned());
    let opened = !no_browser && util::open_browser(&url);
    let text = format!(
        "Apps are created in Silicon Apps: {url}{}\nAs soon as it exists there, it can sign people in. Set up its sign-in on the developer platform ({developer_url}), or here with `silicon-accounts app use <app_id> --secret-stdin` and `silicon-accounts app config set`.",
        if opened {
            " (opened in your browser)"
        } else {
            ""
        }
    );
    Ok(Outcome::new(
        json!({ "silicon_apps_url": url, "developer_url": developer_url, "opened": opened }),
        text,
    ))
}

// ---- imports -----------------------------------------------------------------------------

async fn run_import(ctx: &Ctx, app: &AppClient<'_>, args: ImportArgs) -> CliResult<Outcome> {
    match args.command {
        Some(ImportCommand::Status { job, wait }) => {
            let job = if wait {
                wait_import(ctx, app, &job).await?
            } else {
                app.import_job(&job).await?
            };
            let mut outcome = Outcome::new(to_json(&job), render_job(&job)).next(
                format!(
                    "silicon-accounts app import rows {} --outcome error",
                    job.id
                ),
                "rows with errors",
            );
            if job.dry_run && job.status == "completed" {
                outcome = outcome.next(
                    "silicon-accounts app import <file> --wait",
                    "import the same file for real (without --dry-run)",
                );
            }
            // A failed job is a failure, as for `silicon-accounts app import <file> --wait`, so a script
            // following a job learns it from the exit code.
            Ok(outcome.exit(import_exit(&job)))
        }
        Some(ImportCommand::Rows {
            job,
            outcome,
            level,
            code,
            limit,
            cursor,
        }) => {
            let page = app
                .import_rows(
                    &job,
                    &ImportRowsQuery {
                        outcome,
                        level,
                        code,
                        limit,
                        cursor,
                    },
                )
                .await?;
            let rows: Vec<Vec<String>> = page
                .items
                .iter()
                .map(|r| {
                    vec![
                        r.row_number.to_string(),
                        r.outcome.clone(),
                        r.id.clone()
                            .or_else(|| r.account_uuid.clone())
                            .unwrap_or_default(),
                        r.messages
                            .iter()
                            .map(|m| format!("{} {}: {}", m.level, m.code, m.message))
                            .collect::<Vec<_>>()
                            .join("; "),
                    ]
                })
                .collect();
            Ok(Outcome::new(
                to_json(&page),
                with_more(
                    table(
                        &["ROW", "OUTCOME", "ACCOUNT", "MESSAGES"],
                        &rows,
                        "No rows match.",
                    ),
                    page.next_cursor.as_deref(),
                ),
            ))
        }
        Some(ImportCommand::List) => {
            let page = app.imports(&PageRequest::default()).await?;
            let rows: Vec<Vec<String>> = page
                .items
                .iter()
                .map(|j| {
                    vec![
                        j.id.clone(),
                        j.status.clone(),
                        format!("{}/{}", j.processed_rows, j.total_rows),
                        stamp(j.created_at),
                    ]
                })
                .collect();
            Ok(Outcome::new(
                to_json(&page),
                table(
                    &["JOB", "STATUS", "ROWS", "CREATED"],
                    &rows,
                    "No imports yet.",
                ),
            ))
        }
        None => {
            let Some(file) = args.file.clone() else {
                return Err(CliError::invalid(
                    "Nothing to import: pass a CSV or JSON file (or - for stdin), or a subcommand (status, rows, list).",
                    "Example: silicon-accounts app import users.csv --default-country US --wait",
                ));
            };
            let format = match args.format {
                Some(format) => format,
                None => match file
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(str::to_ascii_lowercase)
                    .as_deref()
                {
                    Some("csv") | Some("txt") => ImportFormat::Csv,
                    Some("json") => ImportFormat::Json,
                    _ if file == Path::new("-") => ImportFormat::Csv,
                    other => {
                        return Err(CliError::invalid(
                            format!(
                                "Can't tell the format of {} from its extension ({}).",
                                file.display(),
                                other.unwrap_or("none")
                            ),
                            "Pass --format csv or --format json.",
                        ));
                    }
                },
            };
            let bytes = read_import_file(&file, format)?;
            if bytes.is_empty() {
                return Err(CliError::invalid(
                    format!("{} is empty.", display_path(&file)),
                    "Pass a file with a header row and at least one row.",
                ));
            }
            let input = match format {
                ImportFormat::Csv => ImportInput::Csv(bytes::Bytes::from(bytes)),
                ImportFormat::Json => {
                    let value: Value = serde_json::from_slice(&bytes).map_err(|e| {
                        CliError::invalid(
                            format!("{} is not valid JSON: {e}.", display_path(&file)),
                            "Pass a list of row objects, or {\"rows\": [...]}.",
                        )
                    })?;
                    let rows = match value {
                        Value::Array(rows) => rows,
                        Value::Object(mut map) => {
                            if map.contains_key("options") {
                                ctx.out.warn("The file's \"options\" are ignored; use the command's flags (--default-country, --dry-run, …).");
                            }
                            match map.remove("rows") {
                                Some(Value::Array(rows)) => rows,
                                _ => {
                                    return Err(CliError::invalid(
                                        format!("{} has no \"rows\" list.", display_path(&file)),
                                        "Pass a list of row objects, or {\"rows\": [...]}.",
                                    ));
                                }
                            }
                        }
                        _ => {
                            return Err(CliError::invalid(
                                "A JSON import must be a list of row objects.",
                                "Example: [{\"email\":\"a@b.com\",\"name\":\"A\"}]",
                            ));
                        }
                    };
                    ImportInput::Json(rows)
                }
            };
            let options = ImportOptions {
                default_country: args.default_country.clone(),
                ignore_unknown_columns: args.ignore_unknown_columns,
                dry_run: args.dry_run,
                update_existing: args.update_existing,
            };
            let key = args
                .idempotency_key
                .clone()
                .unwrap_or_else(util::idempotency_key);
            let job = app.start_import(&input, &options, Some(&key)).await?;
            ctx.telemetry.step(
                "app.import.started",
                0.1,
                json!({ "dry_run": args.dry_run, "format": job.format }),
            );
            if !args.wait {
                let dry = if job.dry_run || args.dry_run {
                    " as a dry run: nothing will be written"
                } else {
                    ""
                };
                return Ok(Outcome::new(
                    to_json(&job),
                    format!("Started import job {} ({}){dry}.", job.id, job.status),
                )
                .next(
                    format!("silicon-accounts app import status {} --wait", job.id),
                    "follow it",
                )
                .next(
                    format!(
                        "silicon-accounts app import rows {} --outcome error",
                        job.id
                    ),
                    "rows with errors",
                ));
            }
            let job = wait_import(ctx, app, &job.id).await?;
            let errors = app
                .import_rows(
                    &job.id,
                    &ImportRowsQuery {
                        outcome: Some("error".to_owned()),
                        limit: Some(10),
                        ..ImportRowsQuery::default()
                    },
                )
                .await
                .map(|p| p.items)
                .unwrap_or_default();
            let mut text = render_job(&job);
            if !errors.is_empty() {
                text.push_str("\nFirst errors:\n");
                for row in &errors {
                    let messages = row
                        .messages
                        .iter()
                        .map(|m| format!("{}: {}", m.code, m.message))
                        .collect::<Vec<_>>()
                        .join("; ");
                    text.push_str(&format!("  row {}: {messages}\n", row.row_number));
                }
            }
            let mut json = to_json(&job);
            json["first_errors"] = to_json(&errors);
            let mut outcome = Outcome::new(json, text).next(
                format!(
                    "silicon-accounts app import rows {} --outcome error",
                    job.id
                ),
                "every row with an error",
            );
            if job.dry_run && job.status == "completed" {
                outcome = outcome.next(
                    real_import_command(&file, &args),
                    "import it for real (the same command without --dry-run)",
                );
            }
            Ok(outcome.exit(import_exit(&job)))
        }
    }
}

async fn wait_import(ctx: &Ctx, app: &AppClient<'_>, job_id: &str) -> CliResult<ImportJob> {
    let out = ctx.out;
    let mut last = (String::new(), u64::MAX);
    let options = WaitOptions::backoff(Duration::from_millis(500), Duration::from_secs(5));
    let wait = app.wait_for_import_with(job_id, &options, |event| match event {
        WaitEvent::Polled(job) => {
            if (job.status.clone(), job.processed_rows) != last {
                last = (job.status.clone(), job.processed_rows);
                // Row counts are small enough for f64 to represent exactly.
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let percent = (job.progress() * 100.0).round() as u64;
                out.progress(&format!(
                    "{}: {}/{} rows ({percent}%)",
                    job.status, job.processed_rows, job.total_rows
                ));
            }
        }
        WaitEvent::TransientError { error, retry_in } => {
            out.warn(&format!(
                "{} Retrying in {}s.",
                error.message(),
                retry_in.as_secs()
            ));
        }
        _ => {}
    });
    tokio::select! {
        result = wait => Ok(result?),
        _ = tokio::signal::ctrl_c() => Err(CliError::new(
            crate::error::EXIT_INTERRUPTED,
            "interrupted",
            format!("Stopped following import {job_id}; it keeps running."),
            format!("Follow it again with `silicon-accounts app import status {job_id} --wait`."),
        )),
    }
}

/// Reads the file to import. A CSV is sent exactly as it is, so one over the import limit is
/// refused before it is read: by its size on disk, or as soon as stdin has carried more than
/// the limit. JSON is re-encoded before it is sent, so for JSON the client checks the encoded
/// body instead (`AppClient::start_import`).
fn read_import_file(file: &Path, format: ImportFormat) -> CliResult<Vec<u8>> {
    if format == ImportFormat::Csv {
        if file == Path::new("-") {
            let mut bytes = Vec::new();
            std::io::stdin()
                .take(MAX_IMPORT_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| {
                    CliError::new(
                        EXIT_FAILURE,
                        "io_error",
                        format!("Could not read the import file from stdin: {e}."),
                        "Retry.",
                    )
                })?;
            if bytes.len() > MAX_IMPORT_BYTES {
                return Err(csv_too_large(
                    format!(
                        "the CSV on stdin carries more than the {MAX_IMPORT_BYTES} bytes one import accepts"
                    ),
                    json!({ "limit_bytes": MAX_IMPORT_BYTES }),
                ));
            }
            return Ok(bytes);
        }
        if let Ok(meta) = std::fs::metadata(file)
            && meta.is_file()
            && meta.len() > MAX_IMPORT_BYTES as u64
        {
            return Err(csv_too_large(
                format!(
                    "{} is {} bytes ({}), and one import accepts at most {MAX_IMPORT_BYTES} bytes",
                    file.display(),
                    meta.len(),
                    megabytes(meta.len())
                ),
                json!({ "size_bytes": meta.len(), "limit_bytes": MAX_IMPORT_BYTES }),
            ));
        }
    }
    util::read_file_or_stdin(file, "the import file")
}

/// The refusal of a CSV over the import limit (`what` says how large it is), before it is
/// uploaded. The service would answer 413 `payload_too_large`, often before the upload ends.
fn csv_too_large(what: String, details: Value) -> CliError {
    CliError::new(
        EXIT_INVALID,
        "payload_too_large",
        format!("The import is over the 50 MB limit: {what}, so it was not uploaded."),
        "Split it into files of at most 50 MB and 100,000 rows each, each starting with the header row, and import them one after another.",
    )
    .with_details(details)
}

/// `size` in MB (1 MB = 1,048,576 bytes, as the limit is counted) with one decimal, rounded
/// up so that a file over the limit never reads as "50.0 MB".
fn megabytes(size: u64) -> String {
    let tenths = size.saturating_mul(10).div_ceil(1024 * 1024);
    format!("{}.{} MB", tenths / 10, tenths % 10)
}

/// The exit code of a finished (or followed) import: 1 when the whole job failed.
fn import_exit(job: &ImportJob) -> i32 {
    if job.status == "failed" {
        EXIT_FAILURE
    } else {
        0
    }
}

/// `silicon-accounts app import <file> …` with the flags of a dry run, minus --dry-run.
fn real_import_command(file: &Path, args: &ImportArgs) -> String {
    let mut command = format!("silicon-accounts app import {}", file.display());
    if let Some(format) = args.format {
        command.push_str(match format {
            ImportFormat::Csv => " --format csv",
            ImportFormat::Json => " --format json",
        });
    }
    if let Some(country) = &args.default_country {
        command.push_str(&format!(" --default-country {country}"));
    }
    if args.ignore_unknown_columns {
        command.push_str(" --ignore-unknown-columns");
    }
    if args.update_existing {
        command.push_str(" --update-existing");
    }
    command.push_str(" --wait");
    command
}

fn render_job(job: &ImportJob) -> String {
    let counts = &job.counts;
    let mut text = format!(
        "Import {}: {} ({}/{} rows)",
        job.id, job.status, job.processed_rows, job.total_rows
    );
    // A dry run writes nothing: its counts are what a real import would do.
    let would = |what: &'static str, real: &'static str| if job.dry_run { what } else { real };
    if job.dry_run {
        text.push_str(" as a dry run: nothing was written; a real import would do this.\n");
    } else {
        text.push_str(".\n");
    }
    text.push_str(&kv(&[
        (would("would create", "created"), counts.created.to_string()),
        (would("would match", "matched"), counts.matched.to_string()),
        (would("would update", "updated"), counts.updated.to_string()),
        (would("would skip", "skipped"), counts.skipped.to_string()),
        ("errors", counts.error.to_string()),
        ("warnings", counts.warnings.to_string()),
        ("failure", job.error.clone().unwrap_or_default()),
    ]));
    text
}

// ---- tokens --------------------------------------------------------------------------------

async fn run_token(app: &AppClient<'_>, command: TokenCommand) -> CliResult<Outcome> {
    let token_outcome = |tokens: silicon_accounts_client::TokenResponse, what: &str| {
        let account = tokens
            .account
            .as_ref()
            .map(|a| format!("{} ({})", a.id, a.uuid))
            .unwrap_or_default();
        let text = format!(
            "{what} for {account}.\n{}",
            kv(&[
                ("access token", tokens.access_token.expose().to_owned()),
                ("expires in", format!("{}s", tokens.expires_in)),
                (
                    "refresh token",
                    tokens
                        .refresh_token
                        .as_ref()
                        .map(|t| t.expose().to_owned())
                        .unwrap_or_default()
                ),
                ("scope", tokens.scope.clone().unwrap_or_default()),
                (
                    "membership",
                    tokens.membership_id.clone().unwrap_or_default()
                ),
            ])
        );
        Outcome::new(to_json(&tokens), text)
    };
    match command {
        TokenCommand::Exchange {
            code,
            redirect_uri,
            code_verifier,
        } => {
            let tokens = app
                .exchange_code(&code, &redirect_uri, code_verifier.as_deref())
                .await?;
            Ok(token_outcome(tokens, "Exchanged the code"))
        }
        TokenCommand::Slt { slt } => {
            let slt = util::arg_or_stdin(&slt, "the short-lived token")?;
            let tokens = app.exchange_slt(&slt).await?;
            Ok(token_outcome(tokens, "Exchanged the short-lived token"))
        }
        TokenCommand::Refresh { refresh_token } => {
            let refresh = util::arg_or_stdin(&refresh_token, "the refresh token")?;
            let tokens = app.refresh(&refresh).await?;
            Ok(token_outcome(
                tokens,
                "Refreshed (store the new refresh token; the old one is dead)",
            ))
        }
        TokenCommand::Introspect { token } => {
            let token = util::arg_or_stdin(&token, "the token")?;
            let result = app.introspect(&token).await?;
            let text = if result.active {
                format!(
                    "active {} for {} ({}), expires {}",
                    result.token_type.clone().unwrap_or_default(),
                    result.id.clone().unwrap_or_default(),
                    result.sub.clone().unwrap_or_default(),
                    result
                        .exp
                        .and_then(|e| OffsetDateTime::from_unix_timestamp(e).ok())
                        .map(|t| when(Some(t)))
                        .unwrap_or_default()
                )
            } else {
                "not active (unknown, expired, revoked, or issued to another app)".to_owned()
            };
            let exit = if result.active { 0 } else { EXIT_INVALID };
            Ok(Outcome::new(to_json(&result), text).exit(exit))
        }
        TokenCommand::Revoke { token } => {
            let token = util::arg_or_stdin(&token, "the token")?;
            app.revoke(&token).await?;
            Ok(Outcome::new(
                json!({ "revoked": true }),
                "Revoked: the token's family no longer works and the account was signed out of the app.",
            ))
        }
        TokenCommand::Verify { access_token } => {
            let token = util::arg_or_stdin(&access_token, "the access token")?;
            let jwks = app_jwks(app).await?;
            match app.verify_access_token_locally(&jwks, &token) {
                Ok(claims) => {
                    let text = format!(
                        "valid: {} ({}) for {}, expires {}",
                        claims.id.clone().unwrap_or_default(),
                        claims.sub,
                        claims.aud.join(","),
                        OffsetDateTime::from_unix_timestamp(claims.exp)
                            .ok()
                            .map(|t| when(Some(t)))
                            .unwrap_or_default()
                    );
                    Ok(Outcome::new(
                        json!({ "valid": true, "claims": to_json(&claims) }),
                        text,
                    ))
                }
                Err(err @ silicon_accounts_client::Error::Token(_)) => {
                    let json = json!({ "valid": false, "reason": err.code(), "message": err.message(), "hint": err.hint() });
                    Ok(Outcome::new(json, format!("not valid: {}", err.message()))
                        .exit(EXIT_INVALID))
                }
                Err(err) => Err(err.into()),
            }
        }
    }
}

async fn app_jwks(app: &AppClient<'_>) -> CliResult<silicon_accounts_client::Jwks> {
    // The JWKS is public; fetch it fresh so rotated keys are picked up.
    Ok(app.client().jwks().await?)
}

// ---- proofs --------------------------------------------------------------------------------

fn verification_name(kind: &str) -> &str {
    match kind {
        "app_verification" => "App verification",
        "user_verification" => "User verification",
        other => other,
    }
}

async fn run_proof(app: &AppClient<'_>, app_id: &str, command: ProofCommand) -> CliResult<Outcome> {
    let issued_outcome = |proof: silicon_accounts_client::IssuedProof| {
        let to = proof.receiving_app.clone().unwrap_or_default();
        let text = format!(
            "{} proof {} from {app_id} for {to}{}.\n{}",
            proof
                .kind
                .map(|k| verification_name(k.as_str()))
                .unwrap_or_default(),
            proof.proof_id,
            proof
                .user
                .as_ref()
                .map(|u| format!(" on behalf of {} ({})", u.id, u.uuid))
                .unwrap_or_default(),
            kv(&[
                ("proof token", proof.proof_token.expose().to_owned()),
                ("expires", when(proof.expires_at)),
                (
                    "refresh token",
                    proof
                        .proof_refresh_token
                        .as_ref()
                        .map(|t| t.expose().to_owned())
                        .unwrap_or_default()
                ),
                ("refresh until", when(proof.refresh_expires_at)),
                ("scopes", proof.scopes.join(" ")),
            ])
        );
        Outcome::new(to_json(&proof), text).next(
            "silicon-accounts app proof verify <proof_token>",
            "how the receiving app checks it",
        )
    };
    match command {
        ProofCommand::UserVerification {
            subject_token,
            to,
            scopes,
            ttl,
            idempotency_key,
        } => {
            let subject_token = util::arg_or_stdin(&subject_token, "the subject token")?;
            let request = IssueUserVerification {
                subject_token,
                receiving_app: to,
                scopes,
                access_ttl_seconds: ttl,
            };
            let key = idempotency_key.unwrap_or_else(util::idempotency_key);
            Ok(issued_outcome(
                app.issue_user_verification(&request, Some(&key)).await?,
            ))
        }
        ProofCommand::AppVerification {
            to,
            scopes,
            ttl,
            idempotency_key,
        } => {
            let receiving_app = to.trim().to_owned();
            let several: Vec<&str> = receiving_app
                .split(|c: char| c == ',' || c.is_whitespace())
                .map(str::trim)
                .filter(|a| !a.is_empty())
                .collect();
            if several.len() > 1 {
                let commands: Vec<String> = several
                    .iter()
                    .map(|a| format!("silicon-accounts app proof app-verification --to {a}"))
                    .collect();
                return Err(CliError::invalid(
                    format!(
                        "An app verification proof is for exactly one app, but --to names {}: {}.",
                        several.len(),
                        several.join(", ")
                    ),
                    format!(
                        "Issue one proof per app; each app verifies its own: {}",
                        commands.join(" ; ")
                    ),
                ));
            }
            let request = IssueAppVerification {
                receiving_app,
                scopes,
                access_ttl_seconds: ttl,
            };
            let key = idempotency_key.unwrap_or_else(util::idempotency_key);
            Ok(issued_outcome(
                app.issue_app_verification(&request, Some(&key)).await?,
            ))
        }
        ProofCommand::Verify { token } => {
            let token = util::arg_or_stdin(&token, "the proof token")?;
            let result = app.verify_proof(&token).await?;
            match &result {
                ProofVerification::Valid(proof) => {
                    let text = format!(
                        "valid: {} proof from {} for {}{}{}, until {}",
                        verification_name(proof.kind.as_str()),
                        proof.issuing_app.app_id,
                        proof.receiving_app.app_id,
                        proof.user.as_ref().map(|u| format!(", on behalf of {} ({})", u.id, u.uuid)).unwrap_or_default(),
                        if proof.scopes.is_empty() { String::new() } else { format!(", scopes {}", proof.scopes.join(" ")) },
                        when(Some(proof.expires_at))
                    );
                    Ok(Outcome::new(result.to_json(), text))
                }
                _ => Ok(Outcome::new(
                    result.to_json(),
                    format!("not valid for {app_id}: unknown, expired, revoked, issued for another app, or its account/app is no longer valid"),
                )
                .exit(EXIT_INVALID)),
            }
        }
        ProofCommand::Refresh { refresh_token, ttl } => {
            let refresh = util::arg_or_stdin(&refresh_token, "the proof refresh token")?;
            Ok(issued_outcome(app.refresh_proof(&refresh, ttl).await?))
        }
        ProofCommand::Revoke {
            proof_id,
            token,
            refresh_token,
        } => {
            let reference = match (proof_id, token, refresh_token) {
                (Some(id), _, _) => ProofRef::Id(id),
                (None, Some(token), _) => {
                    ProofRef::Token(util::arg_or_stdin(&token, "the proof token")?)
                }
                (None, None, Some(token)) => {
                    ProofRef::RefreshToken(util::arg_or_stdin(&token, "the proof refresh token")?)
                }
                (None, None, None) => {
                    return Err(CliError::invalid(
                        "Say which proof to revoke.",
                        "Pass the proof id, --token or --refresh-token.",
                    ));
                }
            };
            app.revoke_proof(&reference).await?;
            Ok(Outcome::new(
                json!({ "revoked": true }),
                "Revoked: the proof no longer verifies.",
            ))
        }
        ProofCommand::List {
            kind,
            status,
            limit,
            cursor,
        } => {
            let page = app
                .proofs(&ProofsQuery {
                    kind,
                    status,
                    limit,
                    cursor,
                })
                .await?;
            let rows: Vec<Vec<String>> = page
                .items
                .iter()
                .map(|p| {
                    vec![
                        p.proof_id.clone(),
                        verification_name(p.kind.as_str()).to_owned(),
                        p.receiving_app.clone(),
                        p.user.as_ref().map(|u| u.id.clone()).unwrap_or_default(),
                        if p.revoked_at.is_some() {
                            "revoked".to_owned()
                        } else {
                            stamp(p.expires_at)
                        },
                    ]
                })
                .collect();
            Ok(Outcome::new(
                to_json(&page),
                with_more(
                    table(
                        &["PROOF", "KIND", "FOR", "ACCOUNT", "EXPIRES"],
                        &rows,
                        "No proofs issued yet.",
                    ),
                    page.next_cursor.as_deref(),
                ),
            ))
        }
    }
}

// ---- webhooks ------------------------------------------------------------------------------

async fn run_webhook(
    app: &AppClient<'_>,
    app_id: &str,
    command: AppWebhookCommand,
) -> CliResult<Outcome> {
    match command {
        AppWebhookCommand::Set {
            endpoint,
            idempotency_key,
        } => {
            let key = idempotency_key.unwrap_or_else(util::idempotency_key);
            let hook = app.set_webhook(&endpoint, Some(&key)).await?;
            let secret = hook
                .secret
                .as_ref()
                .map(|s| {
                    format!(
                        "\nSigning secret (shown once, store it now): {}",
                        s.expose()
                    )
                })
                .unwrap_or_default();
            Ok(Outcome::new(
                to_json(&hook),
                format!("Webhook of {app_id} set to {}.{secret}", hook.url),
            )
            .next("silicon-accounts app webhook test", "send a test ping"))
        }
        AppWebhookCommand::Remove => {
            app.remove_webhook().await?;
            Ok(Outcome::new(
                json!({ "removed": true }),
                format!("Removed the webhook of {app_id}."),
            ))
        }
        AppWebhookCommand::Rotate { idempotency_key } => {
            let key = idempotency_key.unwrap_or_else(util::idempotency_key);
            let secret = app.rotate_webhook_secret(Some(&key)).await?;
            Ok(Outcome::new(
                to_json(&secret),
                format!(
                    "New signing secret (shown once; the old one stopped signing): {}",
                    secret.secret.expose()
                ),
            ))
        }
        AppWebhookCommand::Test { idempotency_key } => {
            let key = idempotency_key.unwrap_or_else(util::idempotency_key);
            let result = app.test_webhook(Some(&key)).await?;
            Ok(Outcome::new(
                to_json(&result),
                format!(
                    "Queued a `ping`{}.",
                    result
                        .event_id
                        .map(|e| format!(" (event {e})"))
                        .unwrap_or_default()
                ),
            )
            .next(
                "silicon-accounts app webhook deliveries",
                "see whether it arrived",
            ))
        }
        AppWebhookCommand::Deliveries {
            status,
            limit,
            cursor,
        } => {
            let page = app
                .deliveries(&DeliveriesQuery {
                    status,
                    limit,
                    cursor,
                })
                .await?;
            Ok(deliveries_outcome(
                &page,
                "silicon-accounts app webhook replay --failed",
            ))
        }
        AppWebhookCommand::Delivery { id } => Ok(delivery_outcome(&app.delivery(&id).await?)),
        AppWebhookCommand::Replay {
            ids,
            failed,
            since,
            idempotency_key,
        } => {
            let request = replay_request(ids, failed, since.as_deref())?;
            let key = idempotency_key.unwrap_or_else(util::idempotency_key);
            let result = app.replay(&request, Some(&key)).await?;
            Ok(replay_outcome(
                &result,
                &format!("Webhook of {app_id}"),
                "silicon-accounts app webhook replay --failed",
                "silicon-accounts app webhook deliveries --status pending",
            ))
        }
    }
}

// ---- event subscriptions -------------------------------------------------------------------

/// The updates a list of `--update` flags (or `--all-updates`) asks for.
fn updates_arg(updates: Vec<String>, all: bool) -> CliResult<Updates> {
    if all {
        return Ok(Updates::All);
    }
    if updates.is_empty() {
        return Ok(Updates::Defaults);
    }
    let mut picked: Vec<String> = Vec::new();
    for u in updates
        .iter()
        .flat_map(|u| u.split(','))
        .map(|u| u.trim().to_ascii_lowercase().replace('-', "_"))
        .filter(|u| !u.is_empty())
    {
        if !APP_UPDATES.contains(&u.as_str()) {
            return Err(CliError::invalid(
                format!("'{u}' is not an update."),
                format!("Pick from {}.", APP_UPDATES.join(", ")),
            ));
        }
        if !picked.contains(&u) {
            picked.push(u);
        }
    }
    Ok(Updates::Only(picked))
}

fn subscription_line(s: &Subscription) -> String {
    let updates = match &s.updates {
        None => "every update".to_string(),
        Some(list) if list.is_empty() => "no updates (test pings only)".to_string(),
        Some(list) => list.join(", "),
    };
    let target = match s.delivery {
        SubscriptionDelivery::Webhook => s.url.clone().unwrap_or_default(),
        _ => s
            .stream_url
            .clone()
            .unwrap_or_else(|| "the event stream".into()),
    };
    format!(
        "{} {} ({}) to {target}\n  updates: {updates}\n  event types: {}",
        to_json(&s.delivery).as_str().unwrap_or("?"),
        s.id,
        to_json(&s.status).as_str().unwrap_or("?"),
        s.event_types.join(", ")
    )
}

async fn run_subscription(
    app: &AppClient<'_>,
    app_id: &str,
    command: AppSubscriptionCommand,
) -> CliResult<Outcome> {
    match command {
        AppSubscriptionCommand::List => {
            let page = app.subscriptions().await?;
            let rows: Vec<Vec<String>> = page
                .items
                .iter()
                .map(|s| {
                    vec![
                        s.id.clone(),
                        to_json(&s.delivery).as_str().unwrap_or("?").to_string(),
                        to_json(&s.status).as_str().unwrap_or("?").to_string(),
                        s.updates
                            .as_ref()
                            .map_or_else(|| "every update".to_string(), |u| u.join(",")),
                        s.url.clone().unwrap_or_default(),
                    ]
                })
                .collect();
            Ok(Outcome::new(
                to_json(&page),
                table(
                    &["SUBSCRIPTION", "DELIVERY", "STATUS", "UPDATES", "URL"],
                    &rows,
                    &format!(
                        "{app_id} has no subscriptions: create one with `silicon-accounts app subscription create stream` or `… create webhook <URL>`."
                    ),
                ),
            ))
        }
        AppSubscriptionCommand::Show { id } => {
            let s = app.subscription(&id).await?;
            Ok(Outcome::new(to_json(&s), subscription_line(&s)))
        }
        AppSubscriptionCommand::Create {
            delivery,
            endpoint,
            updates,
            all_updates,
            paused,
            idempotency_key,
        } => {
            let updates = updates_arg(updates, all_updates)?;
            let mut new = match delivery {
                DeliveryArg::Webhook => {
                    let url = endpoint.ok_or_else(|| {
                        CliError::invalid(
                            "A webhook subscription needs the URL to send updates to.",
                            "Run `silicon-accounts app subscription create webhook https://…`.",
                        )
                    })?;
                    NewSubscription::webhook(url)
                }
                DeliveryArg::Stream => {
                    if endpoint.is_some() {
                        return Err(CliError::invalid(
                            "A stream subscription has no URL.",
                            "Leave the URL out; read the stream at GET /v1/events/stream with the app's credentials.",
                        ));
                    }
                    NewSubscription::stream()
                }
            }
            .with_updates(updates);
            new.paused = paused;
            let key = idempotency_key.unwrap_or_else(util::idempotency_key);
            let s = app.create_subscription(&new, Some(&key)).await?;
            let secret = s
                .secret
                .as_ref()
                .map(|x| {
                    format!(
                        "\nSigning secret (shown once, store it now): {}",
                        x.expose()
                    )
                })
                .unwrap_or_default();
            Ok(Outcome::new(
                to_json(&s),
                format!("Created for {app_id}: {}{secret}", subscription_line(&s)),
            )
            .next(
                format!("silicon-accounts app subscription test {}", s.id),
                "send a test ping",
            ))
        }
        AppSubscriptionCommand::Update {
            id,
            updates,
            all_updates,
            pause,
            resume,
            endpoint,
            idempotency_key,
        } => {
            let changes = SubscriptionChanges {
                updates: updates_arg(updates, all_updates)?,
                status: if pause {
                    Some(SubscriptionStatus::Paused)
                } else if resume {
                    Some(SubscriptionStatus::Active)
                } else {
                    None
                },
                url: endpoint,
            };
            if changes.is_empty() {
                return Err(CliError::invalid(
                    "Nothing to change.",
                    "Pass --update (repeatable), --all-updates, --pause, --resume or --endpoint.",
                ));
            }
            let key = idempotency_key.unwrap_or_else(util::idempotency_key);
            let s = app.update_subscription(&id, &changes, Some(&key)).await?;
            Ok(Outcome::new(
                to_json(&s),
                format!("Updated: {}", subscription_line(&s)),
            ))
        }
        AppSubscriptionCommand::Delete { id } => {
            app.delete_subscription(&id).await?;
            Ok(Outcome::new(
                json!({ "deleted": true, "id": id }),
                format!("Deleted the subscription {id} of {app_id}."),
            ))
        }
        AppSubscriptionCommand::Test {
            id,
            idempotency_key,
        } => {
            let key = idempotency_key.unwrap_or_else(util::idempotency_key);
            let t = app.test_subscription(&id, Some(&key)).await?;
            Ok(Outcome::new(
                to_json(&t),
                format!(
                    "Queued a `ping` (event {}){}.",
                    t.event_id,
                    t.delivery_id
                        .as_deref()
                        .map(|d| format!(", delivery {d}"))
                        .unwrap_or_else(|| ", on the stream".into())
                ),
            ))
        }
    }
}

// ---- deliveries of any webhook (an app's, a Silicon's) ------------------------------------

/// A page of deliveries as a table (app and Silicon webhooks have the same deliveries).
pub(crate) fn deliveries_outcome(page: &Page<WebhookDelivery>, replay: &str) -> Outcome {
    let rows: Vec<Vec<String>> = page
        .items
        .iter()
        .map(|d| {
            vec![
                d.id.clone(),
                d.event_type.clone(),
                d.status.clone(),
                d.attempts.to_string(),
                d.last_status
                    .map(|s| s.to_string())
                    .or_else(|| d.last_error.clone())
                    .unwrap_or_default(),
                stamp(d.created_at),
            ]
        })
        .collect();
    Outcome::new(
        to_json(page),
        with_more(
            table(
                &["DELIVERY", "TYPE", "STATUS", "ATTEMPTS", "LAST", "CREATED"],
                &rows,
                "No deliveries.",
            ),
            page.next_cursor.as_deref(),
        ),
    )
    .next(replay, "re-send failed deliveries")
}

/// One delivery with its attempts and payload.
pub(crate) fn delivery_outcome(detail: &DeliveryDetail) -> Outcome {
    let delivery = &detail.delivery;
    let mut text = kv(&[
        ("delivery", delivery.id.clone()),
        (
            "event",
            format!("{} ({})", delivery.event_id, delivery.event_type),
        ),
        ("url", delivery.url.clone().unwrap_or_default()),
        ("status", delivery.status.clone()),
        ("attempts", delivery.attempts.to_string()),
        (
            "last attempt",
            delivery
                .last_status
                .map(|s| format!("HTTP {s}"))
                .or_else(|| delivery.last_error.clone())
                .unwrap_or_default(),
        ),
        ("next attempt", when(delivery.next_attempt_at)),
        ("delivered", stamp(delivery.delivered_at)),
        (
            "replayed",
            if delivery.manual_replays > 0 {
                format!("{} time(s) by hand", delivery.manual_replays)
            } else {
                String::new()
            },
        ),
    ]);
    if delivery.payload_redacted {
        text.push_str(
            "payload: withheld (the account deleted itself or removed the app's access)\n",
        );
    } else {
        text.push_str(&format!(
            "payload:\n{}\n",
            serde_json::to_string_pretty(&detail.payload).unwrap_or_default()
        ));
    }
    Outcome::new(to_json(detail), text)
}

/// The deliveries a replay names: ids, or every failed one (optionally since a time).
pub(crate) fn replay_request(
    ids: Vec<String>,
    failed: bool,
    since: Option<&str>,
) -> CliResult<ReplayRequest> {
    if !failed {
        return Ok(ReplayRequest::Deliveries(ids));
    }
    let since = match since {
        Some(text) => Some(OffsetDateTime::parse(text.trim(), &Rfc3339).map_err(|_| {
            CliError::invalid(
                format!("--since `{text}` is not an RFC 3339 time."),
                "Write it like 2026-10-01T00:00:00Z.",
            )
        })?),
        None => None,
    };
    Ok(ReplayRequest::Failed { since })
}

/// What a replay did, in words: what was re-queued, what was skipped and why, what is left.
pub(crate) fn replay_outcome(
    result: &ReplayResult,
    webhook: &str,
    again: &str,
    watch: &str,
) -> Outcome {
    let mut text = format!(
        "{webhook}: re-queued {} deliveries (same event ids, sent to the current URL and signed with the current secret).",
        result.replayed_count()
    );
    let skipped = result.skipped.as_array().cloned().unwrap_or_default();
    if !skipped.is_empty() {
        // One line per reason: `2 already_pending: …`.
        let mut reasons: Vec<(String, usize, String)> = Vec::new();
        for item in &skipped {
            let reason = item
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("skipped")
                .to_owned();
            let message = item
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            match reasons.iter_mut().find(|(r, _, _)| *r == reason) {
                Some(entry) => entry.1 += 1,
                None => reasons.push((reason, 1, message)),
            }
        }
        text.push_str(&format!("\nSkipped {}:", skipped.len()));
        for (reason, count, message) in reasons {
            text.push_str(&format!("\n  {count} {reason}: {message}"));
        }
    } else if result.skipped_count() > 0 {
        text.push_str(&format!("\nSkipped {}.", result.skipped_count()));
    }
    let remaining = result
        .extra
        .get("remaining")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if remaining > 0 {
        text.push_str(&format!(
            "\n{remaining} failed deliveries are still waiting (a call re-queues at most 100): run `{again}` again."
        ));
    }
    let not_replayable = result
        .extra
        .get("not_replayable")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if not_replayable > 0 {
        text.push_str(&format!(
            "\n{not_replayable} failed test pings are never replayed: send a new ping instead."
        ));
    }
    let mut outcome = Outcome::new(to_json(result), text);
    if remaining > 0 {
        outcome = outcome.next(again, "re-queue the failed deliveries still waiting");
    }
    outcome.next(watch, "watch them go out")
}
