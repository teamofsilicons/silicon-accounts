//! The clap command, decorated with the full command tree for `accounts --help`.

use clap::{ArgMatches, Command, CommandFactory};
use serde_json::{Value, json};

use crate::cli::Cli;
use crate::docs;

const SHORT_AFTER: &str = "Run `accounts --help` for the whole command tree, `accounts <command> --help` for details and examples, and `accounts docs` for the guides.";

/// The command with the tree, docs, environment and exit codes appended to the root help.
pub fn command() -> Command {
    let base = Cli::command();
    let tree = render_tree(&base);
    let mut topics = String::new();
    let width = docs::TOPICS
        .iter()
        .map(|(n, _, _)| n.len())
        .max()
        .unwrap_or(0);
    for (name, summary, _) in docs::TOPICS {
        topics.push_str(&format!("  {name:<width$}  {summary}\n"));
    }
    let tail = [
        "Environment:",
        "  ACCOUNTS_URL                    Silicon Accounts URL (default account.teamofsilicons.com)",
        "  ACCOUNTS_HOME                   directory holding .accounts/ (beats the configured home)",
        "  SILICON_HOME                    the home when nothing else is set (else ~)",
        "  ACCOUNTS_SILICON, ACCOUNTS_STK  a Silicon's si:id and STK for `accounts login`",
        "  ACCOUNTS_APP_ID                 the app for `accounts app …`",
        "  ACCOUNTS_APP_SECRET             its app secret",
        "  ACCOUNTS_TELEMETRY=0            turn telemetry off",
        "  ACCOUNTS_NO_BROWSER=1           never open a browser",
        "  ACCOUNTS_TIMEOUT_SECONDS        request timeout (default 30)",
        "  ACCOUNTS_ALLOW_INSECURE_HTTP=1  allow plain http to hosts other than this machine",
        "",
        "Exit codes:",
        "  0 ok · 1 failure · 2 invalid input (or the proof/token checked is invalid)",
        "  3 sign-in required or refused · 4 not found · 5 conflict · 6 rate limited or locked",
        "  130 interrupted",
        "",
        "Links:",
        "  Docs     https://account.teamofsilicons.com/docs",
        "  GitHub   https://github.com/teamofsilicons/silicon-accounts",
        "  Package  silicon-accounts-client on crates.io (this CLI is built on it)",
        "",
        "Updates are managed by Silicon Apps; this CLI never updates itself.",
    ]
    .join("\n");
    let long = format!(
        "Command tree (`accounts <command> --help` explains each one, with examples):\n\n{tree}\nDocs bundled in this CLI (`accounts docs <topic>`):\n\n{topics}\n{tail}"
    );
    help_on_missing_subcommand(base.after_help(SHORT_AFTER).after_long_help(long))
}

/// Groups like `accounts silicon` print their help instead of a bare usage error.
fn help_on_missing_subcommand(mut cmd: Command) -> Command {
    let names: Vec<String> = cmd
        .get_subcommands()
        .map(|s| s.get_name().to_owned())
        .collect();
    for name in names {
        cmd = cmd.mut_subcommand(&name, help_on_missing_subcommand);
    }
    if cmd.is_subcommand_required_set() {
        cmd = cmd.arg_required_else_help(true);
    }
    cmd
}

fn entries(cmd: &Command, prefix: &str, depth: usize, out: &mut Vec<(usize, String, String)>) {
    for sub in cmd.get_subcommands() {
        if sub.is_hide_set() {
            continue;
        }
        let path = if prefix.is_empty() {
            sub.get_name().to_owned()
        } else {
            format!("{prefix} {}", sub.get_name())
        };
        let positionals: String = sub
            .get_positionals()
            .map(|a| {
                let name = a.get_value_names().and_then(|v| v.first()).map_or_else(
                    || a.get_id().to_string().to_uppercase(),
                    ToString::to_string,
                );
                if a.is_required_set() {
                    format!(" <{name}>")
                } else {
                    format!(" [{name}]")
                }
            })
            .collect();
        let about = sub.get_about().map(ToString::to_string).unwrap_or_default();
        out.push((depth, format!("{path}{positionals}"), about));
        entries(sub, &path, depth + 1, out);
    }
}

/// Total width of the tree; clap re-wraps lines longer than its 100-column limit.
const TREE_WIDTH: usize = 98;

/// Every command, indented by depth, with descriptions wrapped under their column.
pub fn render_tree(cmd: &Command) -> String {
    let mut list = Vec::new();
    entries(cmd, "", 0, &mut list);
    let width = list
        .iter()
        .map(|(d, p, _)| d * 2 + p.chars().count())
        .max()
        .unwrap_or(0)
        .min(40);
    let indent = 2 + width + 2;
    let mut text = String::new();
    for (depth, path, about) in list {
        let left = format!("{}{path}", "  ".repeat(depth));
        let lines = wrap(&about, TREE_WIDTH.saturating_sub(indent).max(30));
        if left.chars().count() > width {
            text.push_str(&format!("  {left}\n"));
            for line in &lines {
                text.push_str(&format!("{:indent$}{line}\n", ""));
            }
        } else {
            let mut lines = lines.iter();
            text.push_str(&format!(
                "  {left:<width$}  {}\n",
                lines.next().map_or("", String::as_str)
            ));
            for line in lines {
                text.push_str(&format!("{:indent$}{line}\n", ""));
            }
        }
    }
    text
}

/// Greedy word wrap.
fn wrap(text: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        if !line.is_empty() && line.chars().count() + 1 + word.chars().count() > width {
            lines.push(std::mem::take(&mut line));
        }
        if !line.is_empty() {
            line.push(' ');
        }
        line.push_str(word);
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

/// `accounts help` without a topic: the root long help.
pub fn root_long_help() -> String {
    command().render_long_help().to_string()
}

/// The tree as JSON (for `accounts help --json`).
pub fn json_tree() -> Value {
    let mut list = Vec::new();
    entries(&command(), "", 0, &mut list);
    let commands: Vec<Value> = list
        .into_iter()
        .map(|(_, path, about)| json!({ "command": format!("accounts {path}"), "about": about }))
        .collect();
    json!({ "commands": commands })
}

/// Long help for a command path such as `["silicon", "create"]`.
pub fn command_help(path: &[String]) -> Option<String> {
    let mut cmd = command();
    cmd.build();
    let mut current = &mut cmd;
    for name in path {
        current = current.find_subcommand_mut(name)?;
    }
    Some(current.render_long_help().to_string())
}

/// `silicon create` from parsed matches.
pub fn command_path(matches: &ArgMatches) -> String {
    let mut parts = Vec::new();
    let mut current = matches;
    while let Some((name, sub)) = current.subcommand() {
        parts.push(name.to_owned());
        current = sub;
    }
    parts.join(" ")
}
