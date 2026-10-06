//! `accounts report`, `accounts docs`, `accounts help`.

use serde_json::json;

use crate::cli::ReportArgs;
use crate::ctx::Ctx;
use crate::docs;
use crate::error::{CliError, CliResult, EXIT_NOT_FOUND};
use crate::output::Outcome;
use crate::tree;
use crate::util;

const REPO: &str = "https://github.com/teamofsilicons/silicon-accounts";

pub async fn report(ctx: &Ctx, args: ReportArgs) -> CliResult<Outcome> {
    let message = util::arg_or_stdin(&args.message, "the report message")?;
    if message.trim().is_empty() {
        return Err(CliError::invalid(
            "The report message is empty.",
            "Describe what you ran, what you expected and what happened.",
        ));
    }
    let mut body = message.trim().to_owned();
    if !args.no_diagnostics {
        body.push_str(&format!(
            "\n\n--\naccounts CLI {} on {} {}",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH
        ));
    }
    let key = args
        .idempotency_key
        .clone()
        .unwrap_or_else(util::idempotency_key);
    let client = ctx.client()?;
    // Signed-in reports carry the account; a dead session must not block a report.
    let token = match ctx.current_session() {
        Ok(Some(_)) => ctx.session().await.ok().map(|s| s.access_token),
        _ => None,
    };
    let receipt = match client
        .report(&body, args.pr.as_deref(), token.as_deref(), Some(&key))
        .await
    {
        Err(err) if err.status() == Some(401) && token.is_some() => {
            client
                .report(&body, args.pr.as_deref(), None, Some(&key))
                .await?
        }
        other => other?,
    };
    let mut text = format!(
        "Report {} sent: it is emailed to the Silicon Accounts maintainers ({} recipients).",
        receipt.report_id, receipt.recipients
    );
    if args.pr.is_none() {
        text.push_str(&format!("\nYou can also open a PR at {REPO}"));
    }
    Ok(Outcome::new(
        json!({ "report_id": receipt.report_id, "status": receipt.status, "recipients": receipt.recipients, "pr_url": args.pr }),
        text,
    ))
}

pub fn docs(topic: Option<&str>) -> CliResult<Outcome> {
    match topic {
        None => {
            let topics: Vec<_> = docs::TOPICS
                .iter()
                .map(|(name, summary, _)| json!({ "topic": name, "summary": summary }))
                .collect();
            Ok(Outcome::new(json!({ "topics": topics }), docs::index()))
        }
        Some(topic) => match docs::find(topic) {
            Some((name, content)) => Ok(Outcome::new(
                json!({ "topic": name, "content": content }),
                content,
            )),
            None => Err(CliError::new(
                EXIT_NOT_FOUND,
                "unknown_topic",
                format!("There is no docs topic `{topic}`."),
                format!(
                    "Topics: {}.",
                    docs::TOPICS
                        .iter()
                        .map(|(n, _, _)| *n)
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            )),
        },
    }
}

pub fn help(topic: &[String]) -> CliResult<Outcome> {
    if topic.is_empty() {
        return Ok(Outcome::new(tree::json_tree(), tree::root_long_help()));
    }
    let joined = topic.join("-");
    if let Some(mut text) = tree::command_help(topic) {
        if let Some((name, _)) = docs::find(&joined) {
            text.push_str(&format!(
                "\nThere is also a guide on this: `accounts docs {name}`.\n"
            ));
        }
        return Ok(Outcome::new(
            json!({ "command": topic.join(" "), "help": text }),
            text,
        ));
    }
    if let Some((name, content)) = docs::find(&joined) {
        return Ok(Outcome::new(
            json!({ "topic": name, "content": content }),
            content,
        ));
    }
    Err(CliError::new(
        EXIT_NOT_FOUND,
        "unknown_help_topic",
        format!(
            "`{}` is neither a command nor a docs topic.",
            topic.join(" ")
        ),
        "Run `accounts --help` for the command tree and `accounts docs` for the topics.",
    ))
}
