//! Command handlers. Each returns an [`Outcome`] (JSON + plain text + next steps) or a
//! [`crate::error::CliError`].

pub mod account;
pub mod app;
pub mod config;
pub mod login;
pub mod misc;
pub mod silicon;

use crate::cli::Commands;
use crate::ctx::Ctx;
use crate::error::CliResult;
use crate::output::Outcome;

pub async fn run(ctx: &Ctx, command: Commands) -> CliResult<Outcome> {
    match command {
        Commands::Login(args) => login::login(ctx, args).await,
        Commands::Logout => login::logout(ctx).await,
        Commands::Whoami => account::whoami(ctx).await,
        Commands::Id(args) => account::id(ctx, args).await,
        Commands::Lookup(args) => account::lookup(ctx, &args.target).await,
        Commands::Profile(args) => account::profile(ctx, args).await,
        Commands::Email(args) => account::email(ctx, args).await,
        Commands::Phone(args) => account::phone(ctx, args).await,
        Commands::Identities(args) => account::identities(ctx, args).await,
        Commands::Apps(args) => account::my_apps(ctx, args).await,
        Commands::Proofs(args) => account::my_proofs(ctx, args).await,
        Commands::Sessions(args) => account::sessions(ctx, args).await,
        Commands::History(args) => account::history(ctx, args).await,
        Commands::DeleteAccount(args) => account::delete_account(ctx, args).await,
        Commands::Device(args) => account::device(ctx, args).await,
        Commands::Silicon(args) => silicon::silicon(ctx, args).await,
        Commands::Webhook(args) => silicon::own_webhook(ctx, args).await,
        Commands::Custodian(args) => silicon::custodian(ctx, args).await,
        Commands::App(args) => app::app(ctx, args).await,
        Commands::Config(args) => config::config(ctx, args).await,
        Commands::Report(args) => misc::report(ctx, args).await,
        Commands::Docs(args) => misc::docs(args.topic.as_deref()),
        Commands::Help(args) => misc::help(&args.topic),
    }
}
