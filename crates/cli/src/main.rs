//! `accounts`: the Silicon Accounts command line.
//!
//! Built only on the `silicon-accounts-client` package. Stateful: it keeps a session and
//! settings in `{home}/.accounts/`. Results go to stdout (plain text or `--json`), and
//! progress, notices, next steps and errors go to stderr (errors go to stdout as JSON
//! with `--json`).

mod cli;
mod cmd;
mod ctx;
mod docs;
mod error;
mod home;
mod output;
mod tree;
mod util;

use clap::FromArgMatches;
use clap::error::ErrorKind;

use crate::cli::Cli;
use crate::ctx::Ctx;
use crate::error::{CliError, EXIT_FAILURE, EXIT_INVALID};
use crate::output::{Outcome, Output};

fn main() {
    let code = run();
    std::process::exit(code);
}

fn run() -> i32 {
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    let wants_json = args.iter().skip(1).any(|a| a == "--json");
    let mut command = tree::command();
    let matches = match command.try_get_matches_from_mut(args) {
        Ok(matches) => matches,
        Err(err) => return clap_error(&err, wants_json),
    };
    let cli = match Cli::from_arg_matches(&matches) {
        Ok(cli) => cli,
        Err(err) => return clap_error(&err, wants_json),
    };
    let path = tree::command_path(&matches);
    let output = Output {
        json: cli.global.json,
        quiet: cli.global.quiet,
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(err) => {
            output.error(&CliError::new(
                EXIT_FAILURE,
                "internal",
                format!("Could not start the async runtime: {err}."),
                "Retry; report it with `accounts report` if it persists.",
            ));
            return EXIT_FAILURE;
        }
    };
    runtime.block_on(async move {
        let ctx = Ctx::new(cli.global.clone());
        ctx.telemetry.set_command(&path);
        let result = match cli.command {
            None => Ok(Outcome::new(tree::json_tree(), tree::root_long_help())),
            Some(command) => cmd::run(&ctx, command).await,
        };
        match result {
            Ok(outcome) => {
                // A result stdout could not take is a failure, unless the command already failed.
                let exit = if ctx.out.outcome(&outcome) || outcome.exit != 0 {
                    outcome.exit
                } else {
                    EXIT_FAILURE
                };
                ctx.flush_telemetry(exit, None).await;
                exit
            }
            Err(err) => {
                ctx.out.error(&err);
                ctx.flush_telemetry(err.exit, Some(&err)).await;
                err.exit
            }
        }
    })
}

fn clap_error(err: &clap::Error, json: bool) -> i32 {
    match err.kind() {
        ErrorKind::DisplayHelp | ErrorKind::DisplayVersion => {
            let _ = err.print();
            0
        }
        ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand => {
            let _ = err.print();
            EXIT_INVALID
        }
        _ if json => {
            let error = CliError::from(err);
            let text = serde_json::to_string_pretty(&error.to_json()).unwrap_or_default();
            output::print_stdout(&text);
            EXIT_INVALID
        }
        _ => {
            let _ = err.print();
            EXIT_INVALID
        }
    }
}
