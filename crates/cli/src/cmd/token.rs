//! `silicon-accounts token identity`: an identity token for an outside service.

use serde_json::json;
use silicon_accounts_client::AccountKind;

use crate::cli::{OutsideTokenArgs, OutsideTokenCommand};
use crate::ctx::Ctx;
use crate::error::CliResult;
use crate::output::{Outcome, to_json};
use crate::with_session;

pub async fn token(ctx: &Ctx, args: OutsideTokenArgs) -> CliResult<Outcome> {
    match args.command {
        OutsideTokenCommand::Identity { audience, ttl } => {
            ctx.session_of(AccountKind::Silicon, "An identity token")
                .await?;
            let issued = with_session!(ctx, |s| s.identity_token(&audience, Some(ttl)))?;
            ctx.telemetry
                .step("token.identity.issued", 1.0, json!({ "ttl_seconds": ttl }));
            // The token alone on stdout, so `$(silicon-accounts token identity …)` is the JWT.
            let text = issued.identity_token.expose().to_owned();
            Ok(Outcome::new(to_json(&issued), text))
        }
    }
}
