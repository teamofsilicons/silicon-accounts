//! `accounts config …`.

use serde_json::{Value, json};

use crate::cli::{ConfigArgs, ConfigCommand, OnOff};
use crate::ctx::{Ctx, validate_url};
use crate::error::{CliError, CliResult, EXIT_INVALID};
use crate::home;
use crate::output::{Outcome, kv};

pub async fn config(ctx: &Ctx, args: ConfigArgs) -> CliResult<Outcome> {
    match args.command {
        ConfigCommand::Home { dir, reset } => home_command(ctx, dir, reset),
        ConfigCommand::Get { key } => get(ctx, key.as_deref()),
        ConfigCommand::Set { key, value } => set(ctx, &key, &value),
        ConfigCommand::Unset { key } => unset(ctx, &key),
        ConfigCommand::Telemetry { state } => set(
            ctx,
            "telemetry",
            if state == OnOff::On { "on" } else { "off" },
        ),
    }
}

fn overridden_notice(ctx: &Ctx) {
    if ctx.global.home.is_some() {
        ctx.out.notice(
            "Note: --home is set for this command and takes precedence over the configured home.",
        );
    } else if std::env::var_os("ACCOUNTS_HOME").is_some_and(|v| !v.is_empty()) {
        ctx.out
            .notice("Note: ACCOUNTS_HOME is set and takes precedence over the configured home.");
    }
}

fn home_command(ctx: &Ctx, dir: Option<std::path::PathBuf>, reset: bool) -> CliResult<Outcome> {
    let (base, _) = home::base_home()?;
    let pointer = home::pointer_path(&base);
    if reset {
        let removed = home::remove_file(&pointer)?;
        overridden_notice(ctx);
        let text = if removed {
            format!(
                "Forgot the configured home; the CLI now uses {} (from SILICON_HOME or ~).",
                base.display()
            )
        } else {
            format!("No home was configured; the CLI uses {}.", base.display())
        };
        return Ok(Outcome::new(
            json!({ "home": base.display().to_string(), "configured": false }),
            text,
        ));
    }
    let Some(dir) = dir else {
        let home = ctx.home()?;
        let text = kv(&[
            ("home", home.dir.display().to_string()),
            ("source", home.source.describe()),
            ("state", home.state_dir().display().to_string()),
        ]);
        return Ok(Outcome::new(
            json!({ "home": home.dir.display().to_string(), "source": home.source.key(), "state_dir": home.state_dir().display().to_string() }),
            text,
        )
        .next("accounts config home <dir>", "keep the CLI's files somewhere else"));
    };
    if let Err(why) = home::check_dir(&dir) {
        let hint = if why == "it does not exist" {
            format!(
                "Create it first (`mkdir -p {}`), then run this again.",
                dir.display()
            )
        } else {
            "Pass a directory (for example the folder that contains this file).".to_owned()
        };
        return Err(CliError::new(
            EXIT_INVALID,
            "not_a_directory",
            format!("not a directory: {} ({why})", dir.display()),
            hint,
        ));
    }
    let absolute = std::fs::canonicalize(&dir).map_err(|e| CliError::io("resolve", &dir, &e))?;
    home::ensure_private_dir(pointer.parent().unwrap_or(&base))?;
    home::write_private(&pointer, format!("{}\n", absolute.display()).as_bytes())?;
    overridden_notice(ctx);
    let state = absolute.join(home::STATE_DIR);
    Ok(Outcome::new(
        json!({ "home": absolute.display().to_string(), "configured": true, "pointer": pointer.display().to_string(), "state_dir": state.display().to_string() }),
        format!(
            "The CLI now keeps its files in {} (setting stored in {}).\nExisting sessions in the old home are not moved: sign in again, or copy session.json yourself.",
            state.display(),
            pointer.display()
        ),
    ))
}

const KEYS: &str = "url, telemetry, home, app";

fn get(ctx: &Ctx, key: Option<&str>) -> CliResult<Outcome> {
    let (url, url_source) = ctx.url()?;
    let (telemetry, telemetry_source) = ctx.telemetry_setting();
    let home = ctx.home()?;
    let env_app = std::env::var("ACCOUNTS_APP_ID")
        .ok()
        .filter(|v| !v.trim().is_empty());
    let (app, app_source) = match (env_app, ctx.config()?.app.clone()) {
        (Some(app), _) => (Some(app), "env:ACCOUNTS_APP_ID"),
        (None, Some(app)) => (Some(app), "config"),
        (None, None) => (None, "unset"),
    };
    let session = ctx.load_session()?;
    let all = json!({
        "url": { "value": url, "source": url_source.key() },
        "telemetry": { "value": telemetry, "source": telemetry_source },
        "home": { "value": home.dir.display().to_string(), "source": home.source.key(), "state_dir": home.state_dir().display().to_string() },
        "app": { "value": app, "source": app_source },
        "session": session.as_ref().map(|s| json!({ "id": s.account.id, "kind": s.kind.as_str(), "url": s.url })),
        "version": env!("CARGO_PKG_VERSION"),
    });
    if let Some(key) = key {
        let key = key.trim().to_ascii_lowercase();
        let Some(value) = all
            .get(&key)
            .filter(|_| ["url", "telemetry", "home", "app"].contains(&key.as_str()))
        else {
            return Err(CliError::invalid(
                format!("`{key}` is not a setting."),
                format!("Settings: {KEYS}."),
            ));
        };
        let text = match value.get("value") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Null) | None => String::new(),
            Some(other) => other.to_string(),
        };
        return Ok(Outcome::new(value.clone(), text));
    }
    let text = kv(&[
        ("url", format!("{url}  (from {})", url_source.key())),
        (
            "telemetry",
            format!(
                "{}  (from {telemetry_source})",
                if telemetry { "on" } else { "off" }
            ),
        ),
        (
            "home",
            format!("{}  (from {})", home.dir.display(), home.source.describe()),
        ),
        ("state dir", home.state_dir().display().to_string()),
        (
            "app",
            app.map(|a| format!("{a}  (from {app_source})"))
                .unwrap_or_else(|| "none".to_owned()),
        ),
        (
            "signed in",
            session
                .map(|s| format!("{} at {}", s.who(), s.url))
                .unwrap_or_else(|| "no".to_owned()),
        ),
        ("version", env!("CARGO_PKG_VERSION").to_owned()),
    ]);
    Ok(Outcome::new(all, text))
}

fn set(ctx: &Ctx, key: &str, value: &str) -> CliResult<Outcome> {
    let mut config = ctx.config()?.clone();
    let key = key.trim().to_ascii_lowercase();
    let shown = match key.as_str() {
        "url" => {
            let url = validate_url(value)?;
            config.url = Some(url.clone());
            if std::env::var("ACCOUNTS_URL").is_ok_and(|v| !v.trim().is_empty()) {
                ctx.out
                    .notice("Note: ACCOUNTS_URL is set and takes precedence over this setting.");
            }
            if let Some(session) = ctx.load_session()?
                && session.url.trim_end_matches('/') != url
            {
                ctx.out.notice(&format!(
                    "Note: you are signed in at {}; sign in at {url} with `accounts login`.",
                    session.url
                ));
            }
            url
        }
        "telemetry" => {
            let on = silicon_accounts_client::parse_flag(value).ok_or_else(|| {
                CliError::invalid(
                    format!("`{value}` is not on or off."),
                    "Use `accounts config set telemetry on` or `off`.",
                )
            })?;
            config.telemetry = Some(on);
            if on {
                "on".to_owned()
            } else {
                "off".to_owned()
            }
        }
        "app" => {
            let app = value.trim().to_owned();
            ctx.app_path(&app)?;
            config.app = Some(app.clone());
            app
        }
        "home" => {
            return Err(CliError::invalid(
                "The home is not stored in config.json (config.json lives inside it).",
                "Use `accounts config home <dir>`.",
            ));
        }
        other => {
            return Err(CliError::invalid(
                format!("`{other}` is not a setting you can set."),
                "Settings: url, telemetry, app.",
            ));
        }
    };
    let path = ctx.save_config(&config)?;
    Ok(Outcome::new(
        json!({ "key": key, "value": shown, "file": path.display().to_string() }),
        format!("Set {key} = {shown} (in {}).", path.display()),
    ))
}

fn unset(ctx: &Ctx, key: &str) -> CliResult<Outcome> {
    let mut config = ctx.config()?.clone();
    let key = key.trim().to_ascii_lowercase();
    match key.as_str() {
        "url" => config.url = None,
        "telemetry" => config.telemetry = None,
        "app" => config.app = None,
        "home" => {
            return Err(CliError::invalid(
                "The home is reset with `accounts config home --reset`.",
                "Run that instead.",
            ));
        }
        other => {
            return Err(CliError::invalid(
                format!("`{other}` is not a setting."),
                "Settings: url, telemetry, app.",
            ));
        }
    }
    let path = ctx.save_config(&config)?;
    Ok(Outcome::new(
        json!({ "key": key, "unset": true }),
        format!(
            "Removed {key} from {}; the default applies again.",
            path.display()
        ),
    ))
}
