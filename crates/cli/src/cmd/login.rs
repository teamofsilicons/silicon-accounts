//! `accounts login`, `accounts login status`, `accounts logout`.

use serde_json::{Value, json};
use silicon_accounts_client::{
    AccountKind, AccountsClient, Contact, DevicePoll, TokenResponse, WaitEvent,
};
use time::OffsetDateTime;

use crate::cli::{LoginArgs, LoginCommand, LoginStatusArgs};
use crate::ctx::{Ctx, StoredChallenge, StoredSession};
use crate::error::{CliError, CliResult, EXIT_INTERRUPTED};
use crate::home;
use crate::output::{Outcome, json_time, kv, when};
use crate::util;

/// The status JSON shared by `login`, `login status`.
fn status_json(session: &StoredSession, verified: bool) -> Value {
    json!({
        "authenticated": true,
        "kind": session.kind.as_str(),
        "id": session.account.id,
        "uuid": session.account.uuid,
        "display_name": session.account.display_name,
        "expires_at": json_time(Some(session.expires_at)),
        "refresh_expires_at": json_time(session.refresh_expires_at),
        "url": session.url,
        "verified": verified,
    })
}

fn signed_in_text(session: &StoredSession) -> String {
    let name = if session.account.display_name.is_empty() {
        String::new()
    } else {
        format!(" ({})", session.account.display_name)
    };
    let mut text = format!(
        "Signed in as {}{name}, a {}.\n",
        session.who(),
        session.kind.title()
    );
    text.push_str(&kv(&[
        ("uuid", session.account.uuid.clone()),
        ("url", session.url.clone()),
        (
            "access token",
            format!(
                "{} (refreshed automatically)",
                when(Some(session.expires_at))
            ),
        ),
        ("session ends", when(session.refresh_expires_at)),
    ]));
    text
}

fn next_after_login(outcome: Outcome, kind: AccountKind) -> Outcome {
    match kind {
        AccountKind::Silicon => outcome
            .next(
                "accounts login --app <app_id>",
                "get a short-lived token to sign into an app",
            )
            .next("accounts whoami", "see your account and custodian"),
        AccountKind::Carbon => outcome
            .next("accounts whoami", "see your account")
            .next(
                "accounts silicon create --id si:<name>",
                "create a Silicon you are custodian of",
            )
            .next(
                "accounts custodian requests",
                "requests from Silicons that named you",
            ),
    }
}

pub async fn login(ctx: &Ctx, args: LoginArgs) -> CliResult<Outcome> {
    if let Some(LoginCommand::Status(status_args)) = &args.command {
        return status(ctx, status_args).await;
    }
    let label = util::client_label(args.label.as_deref());
    let code_mode = args.email.is_some() || args.phone.is_some() || args.challenge.is_some();
    let silicon = args.silicon.clone().or_else(|| {
        if code_mode {
            None
        } else {
            std::env::var("ACCOUNTS_SILICON")
                .ok()
                .filter(|v| !v.trim().is_empty())
        }
    });
    if (args.stk.is_some() || args.stk_stdin) && silicon.is_none() {
        return Err(CliError::invalid(
            "--stk and --stk-stdin sign in a Silicon, but no si:id was given.",
            "Add --silicon si:<id> (or set ACCOUNTS_SILICON).",
        ));
    }
    if args.code.is_some() && !code_mode {
        return Err(CliError::invalid(
            "--code finishes a code sign-in, but no --email, --phone or --challenge was given.",
            "Run `accounts login --email you@example.com` to send a code, then `accounts login --email you@example.com --code <code>`.",
        ));
    }
    if args.no_browser && (silicon.is_some() || code_mode) {
        ctx.out.notice(
            "Note: --no-browser only matters for the browser (device) sign-in; ignoring it.",
        );
    }

    // Already signed in as the requested account: reuse the session.
    let explicit = silicon.is_some() || code_mode;
    if !args.force
        && let Some(current) = ctx.current_session()?
    {
        let same = match &silicon {
            Some(id) => util::with_prefix(id, AccountKind::Silicon) == current.account.id,
            None => !explicit,
        };
        if same {
            match ctx.session().await {
                Ok(session) => {
                    if let Some(app_id) = &args.app {
                        return short_lived_token(ctx, &session, app_id).await;
                    }
                    let text = format!(
                        "Already signed in as {} ({}). Use `accounts login --force` to sign in again, or `accounts logout` first.",
                        session.who(),
                        session.kind.title()
                    );
                    return Ok(Outcome::new(status_json(&session, false), text).next(
                        "accounts login status",
                        "check the session against the service",
                    ));
                }
                Err(err) if err.code == "session_ended" => {
                    ctx.out
                        .notice(&format!("{} Signing in again.", err.message));
                }
                Err(err) => return Err(err),
            }
        }
    }

    let previous = ctx.load_session()?;
    let (tokens, method) = if let Some(id) = silicon {
        (silicon_login(ctx, &args, &id, &label).await?, "silicon_stk")
    } else if code_mode {
        match code_login(ctx, &args, &label).await? {
            CodeLogin::Tokens(tokens, method) => (*tokens, method),
            CodeLogin::Pending(outcome) => return Ok(outcome),
        }
    } else {
        (device_login(ctx, &args, &label).await?, "device")
    };

    let me = if tokens.account.is_none() {
        Some(
            ctx.client()?
                .with_token(tokens.access_token.expose())
                .me()
                .await?,
        )
    } else {
        None
    };
    let session = ctx.store_tokens(&tokens, me.as_ref(), method)?;
    let _ = home::remove_file(&ctx.home()?.file("login-challenge.json"));
    ctx.telemetry.step(
        "login.done",
        1.0,
        json!({ "method": method, "kind": session.kind.as_str() }),
    );

    if let Some(previous) = previous
        && previous.refresh_token != session.refresh_token
    {
        retire_previous(ctx, &previous, &session).await;
    }

    if let Some(app_id) = &args.app {
        return short_lived_token(ctx, &session, app_id).await;
    }
    let outcome = Outcome::new(status_json(&session, true), signed_in_text(&session));
    Ok(next_after_login(outcome, session.kind))
}

/// Best-effort revocation of the session being replaced.
async fn retire_previous(ctx: &Ctx, previous: &StoredSession, current: &StoredSession) {
    let Some(refresh) = previous.refresh_token.as_deref() else {
        return;
    };
    if previous.url != current.url {
        ctx.out.notice(&format!(
            "Replaced your session at {} ({}); it stays valid there until it is revoked from `accounts sessions list`.",
            previous.url,
            previous.who()
        ));
        return;
    }
    if let Ok(client) = ctx.client() {
        if client.revoke_first_party(refresh).await.is_err() {
            ctx.out.warn(&format!(
                "Could not revoke your previous session as {}; revoke it with `accounts sessions list` / `accounts sessions revoke`.",
                previous.who()
            ));
        } else if previous.account.uuid != current.account.uuid {
            ctx.out.notice(&format!(
                "Signed out of {} first: this home holds one session at a time (use separate homes, e.g. SILICON_HOME, to stay signed in as several accounts).",
                previous.who()
            ));
        }
    }
}

async fn silicon_login(
    ctx: &Ctx,
    args: &LoginArgs,
    id: &str,
    label: &str,
) -> CliResult<TokenResponse> {
    let id = util::with_prefix(id, AccountKind::Silicon);
    if !id.starts_with("si:") {
        return Err(CliError::invalid(
            format!("`{id}` is not a Silicon id: Silicon ids start with si: (e.g. si:scout)."),
            "Carbons sign in with `accounts login` (browser) or `--email` / `--phone`.",
        ));
    }
    let stk = if let Some(stk) = &args.stk {
        ctx.out.warn("Passing an STK as an argument exposes it to other processes and your shell history; prefer --stk-stdin or ACCOUNTS_STK.");
        stk.clone()
    } else if args.stk_stdin {
        util::read_secret_stdin("the STK")?
    } else if let Some(stk) = std::env::var("ACCOUNTS_STK")
        .ok()
        .filter(|v| !v.trim().is_empty())
    {
        stk
    } else if util::interactive(ctx.global.json) {
        util::prompt_secret(&format!("STK for {id}: "))?
    } else {
        return Err(CliError::invalid(
            format!("No STK was given for {id}."),
            "Pipe it with --stk-stdin, set ACCOUNTS_STK, or pass --stk.",
        ));
    };
    let stk = util::normalize_stk(&stk)?;
    let client = ctx.client()?;
    ctx.telemetry.step("login.silicon.started", 0.3, json!({}));
    Ok(client.silicon_login(&id, &stk, Some(label)).await?)
}

enum CodeLogin {
    Tokens(Box<TokenResponse>, &'static str),
    Pending(Outcome),
}

async fn code_login(ctx: &Ctx, args: &LoginArgs, label: &str) -> CliResult<CodeLogin> {
    let client = ctx.client()?;
    let (url, _) = ctx.url()?;
    let challenge_path = ctx.home()?.file("login-challenge.json");
    let method = if args.phone.is_some() {
        "phone"
    } else {
        "email"
    };

    if let Some(challenge_id) = &args.challenge {
        let code = match &args.code {
            Some(code) => code.clone(),
            None if util::interactive(ctx.global.json) => util::prompt("6-digit code: ")?,
            None => {
                return Err(CliError::invalid(
                    "--challenge needs the code too.",
                    format!(
                        "Run `accounts login --challenge {challenge_id} --code <6-digit code>`."
                    ),
                ));
            }
        };
        let tokens = client
            .cli_login_verify(challenge_id, &code, Some(label))
            .await?;
        return Ok(CodeLogin::Tokens(Box::new(tokens), method));
    }

    let contact = match (&args.email, &args.phone) {
        (Some(email), _) => Contact::Email(email.trim().to_owned()),
        (None, Some(phone)) => Contact::Phone {
            phone: phone.trim().to_owned(),
            country: args.country.clone(),
        },
        (None, None) => {
            return Err(CliError::invalid(
                "A code sign-in needs --email, --phone or --challenge.",
                "Run `accounts login --email you@example.com`.",
            ));
        }
    };
    let key = contact.value().trim().to_ascii_lowercase();
    let flag = if matches!(contact, Contact::Email(_)) {
        "--email"
    } else {
        "--phone"
    };

    if let Some(code) = &args.code {
        let saved: Option<StoredChallenge> = home::read_json(&challenge_path)?;
        let Some(saved) = saved.filter(|s| s.contact == key && s.url == url) else {
            return Err(CliError::invalid(
                format!(
                    "No sign-in code is waiting for {}: --code finishes a sign-in that `accounts login {flag} {}` started.",
                    contact.value(),
                    contact.value()
                ),
                format!(
                    "Run `accounts login {flag} {}` first to send a code, then rerun with --code.",
                    contact.value()
                ),
            ));
        };
        let tokens = client
            .cli_login_verify(&saved.challenge_id, code, Some(label))
            .await?;
        return Ok(CodeLogin::Tokens(Box::new(tokens), method));
    }

    let challenge = client.cli_login_start(&contact).await?;
    ctx.telemetry
        .step("login.code.sent", 0.4, json!({ "channel": method }));
    let stored = StoredChallenge {
        challenge_id: challenge.challenge_id.clone(),
        contact: key,
        destination: challenge.destination.clone(),
        expires_at: challenge.expires_at,
        url,
    };
    home::write_json(&challenge_path, &stored)?;

    if util::interactive(ctx.global.json) {
        ctx.out.essential(
            &format!(
                "A 6-digit code was sent to {} (valid {}).",
                challenge.destination,
                until(challenge.expires_at)
            ),
            &json!({}),
        );
        for attempt in 1..=3 {
            let code = util::prompt("Code: ")?;
            match client
                .cli_login_verify(&challenge.challenge_id, &code, Some(label))
                .await
            {
                Ok(tokens) => return Ok(CodeLogin::Tokens(Box::new(tokens), method)),
                Err(err)
                    if (err.is_code("invalid_code") || err.is_code("invalid_input"))
                        && attempt < 3 =>
                {
                    ctx.out.warn(&err.message());
                }
                Err(err) => return Err(err.into()),
            }
        }
    }

    let finish = format!("accounts login {flag} {} --code <code>", contact.value());
    let text = format!(
        "A 6-digit code was sent to {} (valid {}).\nFinish signing in with:\n  {finish}",
        challenge.destination,
        until(challenge.expires_at)
    );
    let json = json!({
        "status": "code_sent",
        "authenticated": false,
        "challenge_id": challenge.challenge_id,
        "destination": challenge.destination,
        "expires_at": json_time(challenge.expires_at),
        "next": finish,
    });
    Ok(CodeLogin::Pending(Outcome::new(json, text)))
}

fn until(t: Option<OffsetDateTime>) -> String {
    match t {
        Some(t) => format!("until {}", when(Some(t))),
        None => "for 10 minutes".to_owned(),
    }
}

async fn device_login(ctx: &Ctx, args: &LoginArgs, label: &str) -> CliResult<TokenResponse> {
    let client: &AccountsClient = ctx.client()?;
    let device = client.device_authorize(Some(label)).await?;
    let expires_at = OffsetDateTime::now_utc()
        + time::Duration::seconds(i64::try_from(device.expires_in).unwrap_or(600));
    let opened = !args.no_browser && util::open_browser(device.browser_url());
    ctx.telemetry.step(
        "login.device.code_shown",
        0.3,
        json!({ "browser_opened": opened }),
    );
    let browser_note = if opened {
        "Your browser was opened; confirm the code there.".to_owned()
    } else {
        format!(
            "Open {} in a browser where you are signed in (or sign in there first).",
            device.browser_url()
        )
    };
    ctx.out.essential(
        &format!(
            "To sign in, go to {} and enter the code\n\n    {}\n\n{browser_note}\nWaiting for approval (the code expires in {} minutes; Ctrl-C to cancel)…",
            device.verification_uri,
            device.user_code,
            device.expires_in.div_ceil(60)
        ),
        &json!({
            "event": "device_code",
            "user_code": device.user_code,
            "verification_uri": device.verification_uri,
            "verification_uri_complete": device.verification_uri_complete,
            "expires_at": json_time(Some(expires_at)),
            "browser_opened": opened,
        }),
    );
    let out = ctx.out;
    let wait = client.wait_for_device_tokens(&device, |event| match event {
        WaitEvent::Polled(DevicePoll::SlowDown) => out.progress(
            "The service asked to poll more slowly; waiting a bit longer between checks.",
        ),
        WaitEvent::TransientError { error, retry_in } => {
            out.warn(&format!(
                "{} Retrying in {}s.",
                error.message(),
                retry_in.as_secs()
            ));
        }
        _ => {}
    });
    let tokens = tokio::select! {
        result = wait => result?,
        _ = tokio::signal::ctrl_c() => {
            return Err(CliError::new(
                EXIT_INTERRUPTED,
                "interrupted",
                format!("Stopped waiting for approval of code {}.", device.user_code),
                "Run `accounts login` again to get a new code.",
            ));
        }
    };
    ctx.telemetry.step("login.device.approved", 0.9, json!({}));
    Ok(tokens)
}

/// Mints a short-lived token for an app with the stored session.
pub async fn short_lived_token(
    ctx: &Ctx,
    session: &StoredSession,
    app_id: &str,
) -> CliResult<Outcome> {
    let app_id = app_id.trim().to_owned();
    let slt = crate::with_session!(ctx, |s| s.short_lived_token(&app_id))?;
    ctx.telemetry
        .step("login.slt.issued", 1.0, json!({ "app": app_id }));
    ctx.out.notice(&format!(
        "Short-lived token for {} as {}: single use, valid {}. The app exchanges it with grant_type=urn:silicon:params:oauth:grant-type:slt.",
        slt.app_id,
        session.who(),
        until(Some(slt.expires_at))
    ));
    let json = json!({ "slt": slt.slt.expose(), "app_id": slt.app_id, "expires_at": json_time(Some(slt.expires_at)) });
    Ok(Outcome::new(json, slt.slt.expose().to_owned()))
}

async fn status(ctx: &Ctx, args: &LoginStatusArgs) -> CliResult<Outcome> {
    let (url, _) = ctx.url()?;
    let not_signed_in = |json: Value, text: String| {
        Outcome::new(json, text)
            .next("accounts login", "sign in as a Carbon (browser code)")
            .next(
                "accounts login --silicon si:<id> --stk-stdin",
                "sign in as a Silicon",
            )
            .exit(1)
    };
    let Some(stored) = ctx.load_session()? else {
        return Ok(not_signed_in(
            json!({ "authenticated": false }),
            format!("Not signed in to {url}."),
        ));
    };
    if stored.url.trim_end_matches('/') != url {
        return Ok(not_signed_in(
            json!({ "authenticated": false, "reason": "signed_in_elsewhere", "session_url": stored.url }),
            format!(
                "Not signed in to {url} (you are signed in to {} as {}).",
                stored.url,
                stored.who()
            ),
        ));
    }
    if args.offline {
        let ended = stored
            .refresh_expires_at
            .is_some_and(|t| t <= OffsetDateTime::now_utc());
        if ended {
            return Ok(not_signed_in(
                json!({ "authenticated": false, "reason": "session_ended" }),
                format!("Your session as {} has ended.", stored.who()),
            ));
        }
        return Ok(Outcome::new(
            status_json(&stored, false),
            signed_in_text(&stored),
        ));
    }
    match crate::with_session!(ctx, |s| s.me()) {
        Ok(me) => {
            let mut session = ctx.session().await?;
            if session.account.id != me.id || session.account.display_name != me.display_name {
                session.account.id.clone_from(&me.id);
                session.account.display_name.clone_from(&me.display_name);
                ctx.save_session(&session)?;
            }
            Ok(Outcome::new(
                status_json(&session, true),
                signed_in_text(&session),
            ))
        }
        Err(err) if err.code == "session_ended" => Ok(not_signed_in(
            json!({ "authenticated": false, "reason": "session_ended", "message": err.message }),
            format!("{} Sign in again with `accounts login`.", err.message),
        )),
        Err(err) if err.transport => {
            ctx.out.warn(&format!(
                "{} Reporting the stored session without checking it.",
                err.message
            ));
            let mut json = status_json(&stored, false);
            json["warning"] = json!(err.message);
            Ok(Outcome::new(json, signed_in_text(&stored)))
        }
        Err(err) => Err(err),
    }
}

pub async fn logout(ctx: &Ctx) -> CliResult<Outcome> {
    let Some(stored) = ctx.load_session()? else {
        return Ok(Outcome::new(
            json!({ "signed_out": false, "reason": "not_signed_in" }),
            "You were not signed in; nothing to do.",
        ));
    };
    let mut revoked = false;
    if let Some(refresh) = stored.refresh_token.as_deref() {
        let client = AccountsClient::builder()
            .base_url(&stored.url)
            .user_agent(format!("accounts-cli/{}", env!("CARGO_PKG_VERSION")))
            .telemetry(ctx.telemetry_setting().0)
            .allow_insecure_http(true)
            .build();
        match client {
            Ok(client) => match client.revoke_first_party(refresh).await {
                Ok(()) => revoked = true,
                Err(err) => ctx.out.warn(&format!(
                    "Could not revoke the session at {}: {} The local session is deleted anyway; revoke it later from `accounts sessions list` on another device.",
                    stored.url,
                    err.message()
                )),
            },
            Err(err) => ctx.out.warn(&err.message()),
        }
    }
    ctx.clear_session()?;
    let text = format!("Signed out of {} ({}).", stored.who(), stored.url);
    Ok(Outcome::new(
        json!({ "signed_out": true, "id": stored.account.id, "uuid": stored.account.uuid, "revoked": revoked }),
        text,
    )
    .next("accounts login", "sign in again"))
}
