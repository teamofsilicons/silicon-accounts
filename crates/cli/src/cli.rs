//! The command tree. Every command says what it is for (`about`), how it is used with
//! other commands (`long_about`) and shows examples (`after_long_help`).

use std::path::PathBuf;
use std::time::Duration;

use clap::{Args, Parser, Subcommand, ValueEnum};

use crate::util::duration_arg;

/// The `accounts` command line.
#[derive(Debug, Parser)]
#[command(
    name = "accounts",
    version,
    about = "Silicon Accounts: one account for every Carbon and Silicon, and sign-in for apps.",
    long_about = "Silicon Accounts is the account for every Carbon and Silicon, and the sign-in layer for apps. This CLI is built only on the silicon-accounts-client Rust package and can do everything that package can: sign in, manage your account and the Silicons you are custodian of, and run an app's sign-in (tokens, user base, imports, webhooks, proofs).\n\nEvery command explains itself with --help, prints machine-readable output with --json, and says exactly what went wrong and what to do next when it fails.",
    disable_help_subcommand = true,
    max_term_width = 100
)]
pub struct Cli {
    #[command(flatten)]
    pub global: GlobalArgs,

    #[command(subcommand)]
    pub command: Option<Commands>,
}

/// Flags every command accepts.
#[derive(Debug, Clone, Args)]
pub struct GlobalArgs {
    /// Print machine-readable JSON on stdout (errors too: {"error":{"code","message","hint"}}).
    #[arg(long, global = true, help_heading = "Global options")]
    pub json: bool,

    /// Silicon Accounts URL [default: ACCOUNTS_URL, then `accounts config set url`, then https://accounts.teamofsilicons.com].
    #[arg(
        long,
        global = true,
        value_name = "URL",
        help_heading = "Global options"
    )]
    pub url: Option<String>,

    /// Directory that holds .accounts/ [default: ACCOUNTS_HOME, then `accounts config home`, then SILICON_HOME, then ~].
    #[arg(
        long,
        global = true,
        value_name = "DIR",
        help_heading = "Global options"
    )]
    pub home: Option<PathBuf>,

    /// Quiet: no progress, notices or next-step suggestions (results and errors still print).
    #[arg(short, long, global = true, help_heading = "Global options")]
    pub quiet: bool,
}

#[derive(Debug, Subcommand)]
pub enum Commands {
    /// Sign in as a Carbon or a Silicon, or get a short-lived token for an app.
    ///
    /// Carbons sign in with a browser code (device flow) or with a 6-digit code sent to their email or phone. Silicons sign in with their si:id and STK. The session is stored in {home}/.accounts/session.json (mode 0600) and refreshed automatically.
    ///
    /// With --app, prints a short-lived token (SLT, 2 minutes, single use) for that app; if you are already signed in it is returned directly. Hand the SLT to the app, which exchanges it for your tokens. This is how Silicons sign into apps. Check the session with `accounts login status --json`.
    #[command(after_long_help = LOGIN_EXAMPLES)]
    Login(LoginArgs),

    /// Sign out: revoke this CLI session and delete the stored tokens.
    ///
    /// Other sessions (the account site, other machines) stay signed in; see `accounts sessions list` to revoke those.
    #[command(after_long_help = "Examples:\n  accounts logout\n  accounts logout --json")]
    Logout,

    /// Show the signed-in account (uuid, id, kind, custodian…).
    ///
    /// Calls GET /v1/me with the stored session. Use `accounts login status` for a quick check that also works offline.
    #[command(
        after_long_help = "Examples:\n  accounts whoami\n  accounts whoami --json | jq -r .uuid"
    )]
    Whoami,

    /// Check whether an id is available, or change your own c:id / si:id.
    ///
    /// The uuid never changes; the c:id or si:id can. After a change your old id stays reserved for you for 10 days (only you can take it back), and every app you signed into is notified, so apps keep working.
    #[command(
        after_long_help = "Examples:\n  accounts id available c:saket\n  accounts id available si:head_of_growth --json\n  accounts id change c:saket_dev"
    )]
    Id(IdArgs),

    /// Look up an account by uuid or by c:id / si:id.
    ///
    /// Shows the public identity (uuid, id, kind, display name, status and a Silicon's custodian). Uses your session, or the app credentials when you are not signed in. Only current ids resolve; store uuids, not ids.
    #[command(
        after_long_help = "Examples:\n  accounts lookup c:saket\n  accounts lookup a8K --json"
    )]
    Lookup(LookupArgs),

    /// Show or edit your profile: display name, timezone, date of birth, photo.
    ///
    /// Apps that can see a changed field are notified with account.updated. A Silicon's date of birth is the day its account was created and can't be changed.
    #[command(
        after_long_help = "Examples:\n  accounts profile show\n  accounts profile set --display-name \"Saket\" --timezone Asia/Kolkata\n  accounts profile set --photo ./me.png\n  accounts profile set --reset-photo"
    )]
    Profile(ProfileArgs),

    /// Manage your email addresses (Carbons): list, add + verify, make primary, remove.
    ///
    /// Up to 10 emails; any of them signs you in. Adding sends a 6-digit code (valid 10 minutes) that you confirm with `accounts email verify`. The primary email can't be removed: make another one primary first.
    #[command(
        after_long_help = "Examples:\n  accounts email list\n  accounts email add work@example.com\n  accounts email verify 0192f0c2-… 123456\n  accounts email primary work@example.com\n  accounts email remove old@example.com"
    )]
    Email(EmailArgs),

    /// Manage your phone numbers (Carbons): list, add + verify, make primary, remove.
    ///
    /// Works exactly like `accounts email`. Numbers are stored in E.164 (+919876543210); pass --country for local formats.
    #[command(
        after_long_help = "Examples:\n  accounts phone add +919876543210\n  accounts phone add 98765 43210 --country IN\n  accounts phone verify 0192f0c2-… 123456"
    )]
    Phone(PhoneArgs),

    /// List or unlink the Google / Apple identities linked to your account.
    #[command(
        after_long_help = "Examples:\n  accounts identities list\n  accounts identities remove google 1098765432"
    )]
    Identities(IdentitiesArgs),

    /// Apps you signed into: list them, or remove an app's access.
    ///
    /// Removing access revokes the app's tokens for you and the OBO proofs it issued about you, and tells the app (membership.access_removed).
    #[command(
        after_long_help = "Examples:\n  accounts apps list\n  accounts apps remove briefcase"
    )]
    Apps(MyAppsArgs),

    /// OBO proofs apps issued on your behalf: list or revoke them.
    #[command(
        after_long_help = "Examples:\n  accounts proofs list\n  accounts proofs revoke 0192f0c2-…"
    )]
    Proofs(MyProofsArgs),

    /// Your browser sessions and CLI sign-ins: list or revoke them.
    #[command(
        after_long_help = "Examples:\n  accounts sessions list\n  accounts sessions revoke 0192f0c2-…"
    )]
    Sessions(SessionsArgs),

    /// Your account history: sign-ins, id changes, custodian changes, proofs, app access.
    #[command(
        after_long_help = "Examples:\n  accounts history\n  accounts history --kind signin --limit 20\n  accounts history --json --cursor <next_cursor>"
    )]
    History(HistoryArgs),

    /// Silicons: create one, manage the Silicons you are custodian of, check a request.
    ///
    /// A Silicon gets an account in one of two ways: a Carbon creates it (and becomes its custodian), or the Silicon creates its own and names a custodian who must accept within 14 days. Every Silicon always has exactly one custodian, who can rotate its STK, change its details and transfer it to another Carbon.
    #[command(after_long_help = SILICON_EXAMPLES)]
    Silicon(SiliconArgs),

    /// A Silicon's own webhook: get notified about your account (custodian decisions, STK rotations, changes), and see or replay its deliveries.
    ///
    /// Every event has an event_id (dedupe on it) and is signed with your webhook's secret. Deliveries are retried for 72 hours; failed ones can be replayed with the same event id, sent to your current URL and signed with your current secret. Your custodian can do the same with `accounts silicon webhook`.
    #[command(
        after_long_help = "Examples:\n  accounts webhook set https://scout.example/hooks/accounts\n  accounts webhook test\n  accounts webhook deliveries --status failed\n  accounts webhook delivery 0192f0c2-…\n  accounts webhook replay --failed\n  accounts webhook replay 0192f0c2-… 0192f0c3-…\n  accounts webhook remove"
    )]
    Webhook(OwnWebhookArgs),

    /// Custodian requests addressed to you (Carbons): list, accept, decline.
    ///
    /// Requests come from Silicons that named you as custodian, and from custodians transferring a Silicon to you. They expire after 14 days.
    #[command(
        after_long_help = "Examples:\n  accounts custodian requests\n  accounts custodian accept 0192f0c2-…\n  accounts custodian decline 0192f0c2-…"
    )]
    Custodian(CustodianArgs),

    /// Approve or deny a CLI sign-in code shown on another machine (Carbons).
    ///
    /// Same as approving on accounts.teamofsilicons.com/device: the other machine's `accounts login` gets signed in as you.
    #[command(
        after_long_help = "Examples:\n  accounts device show WDJB-MJHT\n  accounts device approve WDJB-MJHT"
    )]
    Device(DeviceArgs),

    /// App mode: an app's sign-in setup, user base, imports, tokens, webhooks and proofs.
    ///
    /// Acts with the app's credentials (--app-id/--app-secret, ACCOUNTS_APP_ID/ACCOUNTS_APP_SECRET, or `accounts app use <app_id> --secret-stdin`), or as the app's owner when you are signed in as the Carbon who owns it. Token calls, OBO proofs, proof verification and refresh need the app's own credentials; an owner can issue ATA proofs (the app's ATA page) and revoke the app's proofs by id. Apps are created in Silicon Apps (`accounts app new`).
    #[command(after_long_help = APP_EXAMPLES)]
    App(AppArgs),

    /// CLI settings: home directory, URL, telemetry.
    ///
    /// Settings live in {home}/.accounts/config.json. Highly configurable with sensible defaults: flags win over environment variables, which win over the config file.
    #[command(
        after_long_help = "Examples:\n  accounts config get\n  accounts config home /srv/scout\n  accounts config set url http://127.0.0.1:8590\n  accounts config telemetry off"
    )]
    Config(ConfigArgs),

    /// Report a bug to the Silicon Accounts maintainers, optionally with the PR that fixes it.
    ///
    /// Every report is emailed to the maintainers. Include what you ran, what you expected and what happened (the request id from the error helps). Signed-in reports carry your account; anonymous ones are allowed.
    #[command(
        after_long_help = "Examples:\n  accounts report \"login --app remind returns 500 (request id 0192…)\"\n  accounts report \"wrong hint for login_locked\" \\\n      --pr https://github.com/teamofsilicons/silicon-accounts/pull/42"
    )]
    Report(ReportArgs),

    /// Read the bundled docs (guides for Silicons, Carbons and apps).
    ///
    /// Run without a topic to list them. Docs ship inside the CLI, so they always match this version.
    #[command(
        after_long_help = "Examples:\n  accounts docs\n  accounts docs silicons\n  accounts docs proofs"
    )]
    Docs(DocsArgs),

    /// Help for a command (`accounts help silicon create`) or a docs topic (`accounts help imports`).
    ///
    /// A command's help wins when a docs topic has the same name (`accounts help proofs` is the `accounts proofs` command); read that guide with `accounts docs proofs`.
    Help(HelpArgs),

    /// Delete your account permanently (requires --confirm <your id>).
    ///
    /// Apps you signed into are told (account.deleted), your sessions and proofs are revoked and your id is held for 10 days. A Carbon who is custodian of any Silicon must transfer them first (`accounts silicon transfer`).
    #[command(after_long_help = "Examples:\n  accounts delete-account --confirm c:saket")]
    DeleteAccount(DeleteAccountArgs),
}

const LOGIN_EXAMPLES: &str = "Examples:
  accounts login                                   Carbon: browser code (device flow)
  accounts login --no-browser                      print the code and URL only
  accounts login --email saket@example.com         Carbon: code by email (prompts for it)
  accounts login --email saket@example.com --code 123456
                                                   finish a code sent by an earlier call
  printf '%s' \"$STK\" | accounts login --silicon si:scout --stk-stdin
  ACCOUNTS_SILICON=si:scout ACCOUNTS_STK=stk-… accounts login --json
  accounts login --app remind                      print a short-lived token for remind
  accounts login status --json                     {\"authenticated\":true,\"kind\":\"silicon\",…}

Exit codes: 0 ok, 1 failure, 2 invalid input, 3 not signed in or credentials refused,
6 locked or rate limited.";

const SILICON_EXAMPLES: &str = "Examples:
  As a Carbon (you become the custodian):
    accounts silicon create --id si:scout --display-name Scout
  As a Silicon (your custodian must accept):
    accounts silicon create --id si:scout --custodian c:saket --wait
    accounts silicon create --id si:scout --custodian saket@example.com \\
        --webhook https://scout.example/hooks
    accounts silicon request status 0192f0c2-… --wait
  Custodian tasks:
    accounts silicon list
    accounts silicon rotate-stk si:scout
    accounts silicon webhook deliveries si:scout --status failed
    accounts silicon transfer si:scout --to c:shubham
    accounts silicon delete si:scout --confirm si:scout";

const APP_EXAMPLES: &str = "Examples:
  printf '%s' \"$SECRET\" | accounts app use briefcase --secret-stdin
  accounts app show
  accounts app config set - <<< '{\"methods\":{\"google\":true}}'
  accounts app users --q saket
  accounts app import users.csv --default-country US --wait
  accounts app token exchange --code sac_… --code-verifier … \\
      --redirect-uri https://briefcase.example/callback
  accounts app token slt slt_…
  accounts app proof obo --subject-token eyJ… --to briefcase --scope files.write
  accounts app proof verify sap_… && echo valid
  accounts app webhook set https://briefcase.example/webhooks
  accounts app webhook replay --failed";

// ---- login --------------------------------------------------------------------------------

#[derive(Debug, Args)]
#[command(args_conflicts_with_subcommands = true)]
pub struct LoginArgs {
    #[command(subcommand)]
    pub command: Option<LoginCommand>,

    /// Sign in as this Silicon (si:id) with its STK [env: ACCOUNTS_SILICON].
    #[arg(long, value_name = "SI_ID", conflicts_with_all = ["email", "phone", "challenge"])]
    pub silicon: Option<String>,

    /// The Silicon's STK (prefer --stk-stdin or ACCOUNTS_STK: arguments are visible to other processes).
    #[arg(long, value_name = "STK", conflicts_with = "stk_stdin")]
    pub stk: Option<String>,

    /// Read the STK from stdin.
    #[arg(long)]
    pub stk_stdin: bool,

    /// Carbon: send a 6-digit sign-in code to this email.
    #[arg(long, value_name = "EMAIL", conflicts_with = "phone")]
    pub email: Option<String>,

    /// Carbon: send a 6-digit sign-in code by SMS to this phone number.
    #[arg(long, value_name = "PHONE")]
    pub phone: Option<String>,

    /// Country for a local phone number (ISO code, e.g. IN, US).
    #[arg(long, value_name = "CC", requires = "phone")]
    pub country: Option<String>,

    /// Finish a code sign-in started earlier (the challenge id it printed).
    #[arg(long, value_name = "CHALLENGE_ID")]
    pub challenge: Option<String>,

    /// The 6-digit code you received (with --email/--phone/--challenge).
    #[arg(long, value_name = "CODE")]
    pub code: Option<String>,

    /// After signing in (or right away if already signed in), print a short-lived token for this app.
    #[arg(long, value_name = "APP_ID")]
    pub app: Option<String>,

    /// Device flow: don't open a browser, just print the code and URL.
    #[arg(long)]
    pub no_browser: bool,

    /// Label for this sign-in in your session list [default: accounts CLI on <host> (<os>)].
    #[arg(long, value_name = "TEXT")]
    pub label: Option<String>,

    /// Sign in again even if already signed in.
    #[arg(long)]
    pub force: bool,
}

#[derive(Debug, Subcommand)]
pub enum LoginCommand {
    /// Report whether you are signed in and as whom (exit 0 signed in, 1 not).
    ///
    /// Checks the stored session against the service (refreshing it if needed) unless --offline. JSON: {"authenticated":true,"kind":"silicon","id":"si:scout","uuid":"…","expires_at":"…"} or {"authenticated":false}.
    #[command(
        after_long_help = "Examples:\n  accounts login status\n  accounts login status --json\n  accounts login status --offline --json"
    )]
    Status(LoginStatusArgs),
}

#[derive(Debug, Args)]
pub struct LoginStatusArgs {
    /// Only read the stored session; don't contact the service.
    #[arg(long)]
    pub offline: bool,
}

// ---- ids, lookup, profile -----------------------------------------------------------------

#[derive(Debug, Args)]
pub struct IdArgs {
    #[command(subcommand)]
    pub command: IdCommand,
}

#[derive(Debug, Subcommand)]
pub enum IdCommand {
    /// Check whether a c:id or si:id can be taken (exit 0 available, 5 taken/reserved, 2 invalid).
    ///
    /// Ids are c: or si: plus 3 to 30 of a-z, 0-9, - and _ (case-insensitive). When signed in, an id reserved for you after a change shows as reclaimable. A custodian adds --for <si:…> to ask for one of its Silicons: an old id of that Silicon shows as reclaimable for it (take it back with `accounts silicon id`).
    #[command(
        after_long_help = "Examples:\n  accounts id available c:saket\n  accounts id available si:scout --json\n  accounts id available si:scout --for si:scout_v2"
    )]
    Available {
        /// The id, e.g. c:saket or si:scout.
        id: String,
        /// Ask for one of your Silicons (its si:id or uuid) instead of yourself.
        #[arg(long = "for", value_name = "SILICON")]
        for_silicon: Option<String>,
    },
    /// Change your own c:id / si:id (the prefix is added if you omit it).
    ///
    /// Your old id stays reserved for you for 10 days. Apps you signed into get account.id_changed; they key on your uuid, so nothing breaks.
    #[command(
        after_long_help = "Examples:\n  accounts id change c:saket_dev\n  accounts id change scout_v2"
    )]
    Change {
        /// The new id.
        new_id: String,
    },
}

#[derive(Debug, Args)]
pub struct LookupArgs {
    /// A uuid (a8K) or an id (c:saket, si:scout).
    pub target: String,
}

#[derive(Debug, Args)]
pub struct ProfileArgs {
    #[command(subcommand)]
    pub command: ProfileCommand,
}

#[derive(Debug, Subcommand)]
pub enum ProfileCommand {
    /// Show your full profile (same as `accounts whoami`).
    Show,
    /// Change profile fields; only the flags you pass change.
    #[command(
        after_long_help = "Examples:\n  accounts profile set --display-name \"Saket\"\n  accounts profile set --timezone Europe/Berlin --dob 1999-04-01\n  accounts profile set --photo ./avatar.png"
    )]
    Set(ProfileSetArgs),
}

#[derive(Debug, Args)]
pub struct ProfileSetArgs {
    /// New display name (1 to 100 characters).
    #[arg(long, value_name = "NAME")]
    pub display_name: Option<String>,
    /// New timezone (IANA name, e.g. Asia/Kolkata).
    #[arg(long, value_name = "TZ")]
    pub timezone: Option<String>,
    /// New date of birth, YYYY-MM-DD (Carbons only).
    #[arg(long, value_name = "YYYY-MM-DD")]
    pub dob: Option<String>,
    /// New profile photo URL (https).
    #[arg(long, value_name = "URL", conflicts_with_all = ["photo", "reset_photo"])]
    pub pfp_url: Option<String>,
    /// Upload a profile photo (PNG, JPEG, WebP or GIF, at most 2 MB).
    #[arg(long, value_name = "FILE", conflicts_with = "reset_photo")]
    pub photo: Option<PathBuf>,
    /// Go back to the default profile photo.
    #[arg(long)]
    pub reset_photo: bool,
}

// ---- contacts ------------------------------------------------------------------------------

#[derive(Debug, Args)]
pub struct EmailArgs {
    #[command(subcommand)]
    pub command: EmailCommand,
}

#[derive(Debug, Subcommand)]
pub enum EmailCommand {
    /// List your email addresses.
    List,
    /// Add an email: sends a 6-digit code (asks for it when run in a terminal).
    Add {
        /// The email address.
        email: String,
    },
    /// Confirm an added email with its code.
    Verify {
        /// The challenge id printed by `accounts email add`.
        challenge_id: String,
        /// The 6-digit code.
        code: String,
    },
    /// Make an email your primary one (apps with the email scope are told).
    Primary {
        /// The email address.
        email: String,
    },
    /// Remove an email (not the primary one).
    Remove {
        /// The email address.
        email: String,
    },
}

#[derive(Debug, Args)]
pub struct PhoneArgs {
    #[command(subcommand)]
    pub command: PhoneCommand,
}

#[derive(Debug, Subcommand)]
pub enum PhoneCommand {
    /// List your phone numbers.
    List,
    /// Add a phone number: sends a 6-digit code by SMS.
    Add {
        /// The number (E.164 like +919876543210, or local with --country).
        phone: String,
        /// Country for a local number (ISO code, e.g. IN).
        #[arg(long, value_name = "CC")]
        country: Option<String>,
    },
    /// Confirm an added number with its code.
    Verify {
        /// The challenge id printed by `accounts phone add`.
        challenge_id: String,
        /// The 6-digit code.
        code: String,
    },
    /// Make a number your primary one.
    Primary {
        /// The number.
        phone: String,
    },
    /// Remove a number (not the primary one).
    Remove {
        /// The number.
        phone: String,
    },
}

#[derive(Debug, Args)]
pub struct IdentitiesArgs {
    #[command(subcommand)]
    pub command: IdentitiesCommand,
}

#[derive(Debug, Subcommand)]
pub enum IdentitiesCommand {
    /// List linked Google / Apple identities.
    List,
    /// Unlink an identity.
    Remove {
        /// google or apple.
        provider: String,
        /// The provider's subject id (from `accounts identities list`).
        subject: String,
    },
}

#[derive(Debug, Args)]
pub struct MyAppsArgs {
    #[command(subcommand)]
    pub command: MyAppsCommand,
}

#[derive(Debug, Subcommand)]
pub enum MyAppsCommand {
    /// List the apps you signed into, with what you share with each.
    List,
    /// Remove an app's access to your account.
    Remove {
        /// The app id, e.g. briefcase.
        app_id: String,
    },
}

#[derive(Debug, Args)]
pub struct MyProofsArgs {
    #[command(subcommand)]
    pub command: MyProofsCommand,
}

#[derive(Debug, Subcommand)]
pub enum MyProofsCommand {
    /// List OBO proofs issued on your behalf.
    List,
    /// Revoke an OBO proof.
    Revoke {
        /// The proof id.
        proof_id: String,
    },
}

#[derive(Debug, Args)]
pub struct SessionsArgs {
    #[command(subcommand)]
    pub command: SessionsCommand,
}

#[derive(Debug, Subcommand)]
pub enum SessionsCommand {
    /// List browser sessions and CLI sign-ins.
    List,
    /// Revoke a session (it is signed out everywhere it is used).
    Revoke {
        /// The session id.
        id: String,
    },
}

#[derive(Debug, Args)]
pub struct HistoryArgs {
    /// Only this kind of entry.
    #[arg(long, value_enum)]
    pub kind: Option<HistoryKind>,
    /// Entries per page (max 200).
    #[arg(long, value_name = "N", value_parser = clap::value_parser!(u32).range(1..=200))]
    pub limit: Option<u32>,
    /// Continue from a previous page's next_cursor.
    #[arg(long, value_name = "CURSOR")]
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
#[value(rename_all = "snake_case")]
pub enum HistoryKind {
    Signin,
    IdChange,
    Custodian,
    Proof,
    AppAccess,
    Security,
}

impl HistoryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Signin => "signin",
            Self::IdChange => "id_change",
            Self::Custodian => "custodian",
            Self::Proof => "proof",
            Self::AppAccess => "app_access",
            Self::Security => "security",
        }
    }
}

#[derive(Debug, Args)]
pub struct DeleteAccountArgs {
    /// Your current id, to confirm (e.g. c:saket).
    #[arg(long, value_name = "ID")]
    pub confirm: Option<String>,
}

#[derive(Debug, Args)]
pub struct DeviceArgs {
    #[command(subcommand)]
    pub command: DeviceCommand,
}

#[derive(Debug, Subcommand)]
pub enum DeviceCommand {
    /// Show a pending CLI sign-in (label, status, expiry).
    Show {
        /// The code shown by the other machine, e.g. WDJB-MJHT.
        code: String,
    },
    /// Approve it: the other machine gets signed in as you.
    Approve {
        /// The code.
        code: String,
    },
    /// Deny it.
    Deny {
        /// The code.
        code: String,
    },
}

// ---- silicons ------------------------------------------------------------------------------

#[derive(Debug, Args)]
pub struct SiliconArgs {
    #[command(subcommand)]
    pub command: SiliconCommand,
}

#[derive(Debug, Subcommand)]
pub enum SiliconCommand {
    /// Create a Silicon account.
    ///
    /// Signed in as a Carbon: you create it and become its custodian; it can sign in right away. Otherwise (or with --self-create) the Silicon creates its own account and names its custodian (--custodian c:id or email), who has 14 days to accept on accounts.teamofsilicons.com or with `accounts custodian accept`. With --wait the command polls until the custodian decides (5 s backing off to 60 s) and then signs the Silicon in; without it, check later with `accounts silicon request status <id>`.
    ///
    /// The generated STK is printed exactly once: store it. Choose your own with --stk-stdin (8 to 32 hex characters).
    #[command(
        after_long_help = "Examples:\n  accounts silicon create --id si:scout --display-name Scout\n  accounts silicon create --id si:scout --custodian c:saket --wait\n  accounts silicon create --id si:scout --custodian saket@example.com \\\n      --webhook https://scout.example/hooks\n  openssl rand -hex 16 | accounts silicon create --id si:scout --custodian c:saket --stk-stdin"
    )]
    Create(SiliconCreateArgs),

    /// List the Silicons you are custodian of.
    List,

    /// Show one of your Silicons (by si:id or uuid).
    Show {
        /// si:id or uuid.
        silicon: String,
    },

    /// Change one of your Silicons' display name, timezone or photo (a URL, or upload a file).
    ///
    /// --photo uploads a PNG, JPEG, WebP or GIF of at most 2 MB (`-` reads stdin); the photo belongs to the Silicon. Apps it signed into and the Silicon's webhook are told what changed.
    #[command(
        after_long_help = "Examples:\n  accounts silicon update si:scout --display-name Scout\n  accounts silicon update si:scout --photo ./scout.png\n  accounts silicon update si:scout --timezone Europe/Paris --pfp-url https://cdn.example.com/scout.png"
    )]
    Update {
        /// si:id or uuid.
        silicon: String,
        /// New display name.
        #[arg(long, value_name = "NAME")]
        display_name: Option<String>,
        /// New timezone (IANA).
        #[arg(long, value_name = "TZ")]
        timezone: Option<String>,
        /// New photo URL (https).
        #[arg(long, value_name = "URL", conflicts_with = "photo")]
        pfp_url: Option<String>,
        /// Upload this image as its photo (`-` = stdin).
        #[arg(long, value_name = "FILE")]
        photo: Option<std::path::PathBuf>,
    },

    /// Change one of your Silicons' si:id (apps it signed into are notified).
    Id {
        /// Current si:id or uuid.
        silicon: String,
        /// The new si:id.
        new_id: String,
    },

    /// Rotate a Silicon's STK: the old one stops working and its sessions are revoked.
    ///
    /// Prints the new STK exactly once (or sets yours with --stk-stdin). Apps it signed into get membership.signed_out; the Silicon gets silicon.stk_rotated.
    #[command(
        after_long_help = "Examples:\n  accounts silicon rotate-stk si:scout\n  printf 'stk-%s' \"$(openssl rand -hex 16)\" | accounts silicon rotate-stk si:scout --stk-stdin"
    )]
    RotateStk {
        /// si:id or uuid.
        silicon: String,
        /// The new STK (prefer --stk-stdin).
        #[arg(long, value_name = "STK", conflicts_with = "stk_stdin")]
        stk: Option<String>,
        /// Read the new STK from stdin.
        #[arg(long)]
        stk_stdin: bool,
    },

    /// One of your Silicons' webhook: set or remove the endpoint, see and replay its deliveries.
    ///
    /// The same webhook the Silicon manages itself with `accounts webhook`. Failed deliveries can be replayed with the same event id, sent to the current URL and signed with the current secret.
    #[command(
        after_long_help = "Examples:\n  accounts silicon webhook set si:scout https://scout.example/hooks/accounts\n  accounts silicon webhook deliveries si:scout --status failed\n  accounts silicon webhook replay si:scout --failed\n  accounts silicon webhook remove si:scout"
    )]
    Webhook(SiliconWebhookArgs),

    /// Transfer a Silicon to another Carbon (they must accept within 14 days).
    Transfer {
        /// si:id or uuid.
        silicon: String,
        /// The receiving Carbon: c:id or email.
        #[arg(long, value_name = "C_ID_OR_EMAIL")]
        to: String,
    },

    /// Cancel a pending transfer.
    CancelTransfer {
        /// si:id or uuid.
        silicon: String,
    },

    /// Delete one of your Silicons permanently.
    Delete {
        /// si:id or uuid.
        silicon: String,
        /// The Silicon's si:id, to confirm.
        #[arg(long, value_name = "SI_ID")]
        confirm: Option<String>,
    },

    /// A self-created Silicon's custodian request.
    Request(RequestArgs),
}

#[derive(Debug, Args)]
pub struct SiliconCreateArgs {
    /// The si:id to take (si: is added if omitted).
    #[arg(long, value_name = "SI_ID")]
    pub id: String,
    /// Display name [default: from the id, e.g. si:head_of_growth → Head of growth].
    #[arg(long, value_name = "NAME")]
    pub display_name: Option<String>,
    /// The custodian Carbon (c:id or email); required when the Silicon creates its own account.
    #[arg(long, value_name = "C_ID_OR_EMAIL")]
    pub custodian: Option<String>,
    /// Choose the STK (prefer --stk-stdin): stk- + 8 to 32 hex characters.
    #[arg(long, value_name = "STK", conflicts_with = "stk_stdin")]
    pub stk: Option<String>,
    /// Read the chosen STK from stdin.
    #[arg(long)]
    pub stk_stdin: bool,
    /// Timezone (IANA) [default: this machine's timezone, else UTC].
    #[arg(long, value_name = "TZ")]
    pub timezone: Option<String>,
    /// Profile photo URL (https) [default: the Silicon mark].
    #[arg(long, value_name = "URL")]
    pub pfp_url: Option<String>,
    /// Webhook endpoint for notifications about the Silicon's account.
    #[arg(long, value_name = "URL")]
    pub webhook: Option<String>,
    /// Self-create: wait until the custodian accepts, declines or the request expires, then sign in.
    #[arg(long)]
    pub wait: bool,
    /// Give up waiting after this long (90s, 30m, 2h, 14d).
    #[arg(long, value_name = "DURATION", value_parser = duration_arg, default_value = "14d")]
    pub timeout: Duration,
    /// Create the Silicon's own account (custodian must accept) even when signed in as a Carbon.
    #[arg(long)]
    pub self_create: bool,
    /// After --wait succeeds, don't sign in as the new Silicon.
    #[arg(long)]
    pub no_login: bool,
    /// Idempotency key; reuse it when retrying so the Silicon is created only once [default: random].
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Args)]
pub struct SiliconWebhookArgs {
    #[command(subcommand)]
    pub command: SiliconWebhookCommand,
}

#[derive(Debug, Subcommand)]
pub enum SiliconWebhookCommand {
    /// Set the endpoint (prints the signing secret once).
    Set {
        /// si:id or uuid.
        silicon: String,
        /// The https endpoint.
        // Not named `url`: that id belongs to the global --url flag, and clap would merge
        // the two (the endpoint would become the service URL).
        #[arg(value_name = "URL")]
        endpoint: String,
    },
    /// Remove the endpoint.
    Remove {
        /// si:id or uuid.
        silicon: String,
    },
    /// List the deliveries of the Silicon's webhook, newest first.
    #[command(
        after_long_help = "Examples:\n  accounts silicon webhook deliveries si:scout\n  accounts silicon webhook deliveries si:scout --status failed --json"
    )]
    Deliveries {
        /// si:id or uuid.
        silicon: String,
        #[command(flatten)]
        filter: DeliveriesFilter,
    },
    /// Show one delivery of the Silicon's webhook with its attempts and the exact payload.
    Delivery {
        /// si:id or uuid.
        silicon: String,
        /// The delivery id.
        id: String,
    },
    /// Re-queue deliveries of the Silicon's webhook (same event id, its current URL and secret).
    ///
    /// Name the deliveries by id, or replay every failed one with --failed (at most 100 per call; run it again while `remaining` is above 0). Test pings are never replayed: send a new one.
    #[command(
        after_long_help = "Examples:\n  accounts silicon webhook replay si:scout --failed\n  accounts silicon webhook replay si:scout --failed --since 2026-10-01T00:00:00Z\n  accounts silicon webhook replay si:scout 0192f0c2-… 0192f0c3-…"
    )]
    Replay {
        /// si:id or uuid.
        silicon: String,
        #[command(flatten)]
        selection: ReplaySelection,
    },
}

/// `--status`, `--limit` and `--cursor` of a delivery list.
#[derive(Debug, Args)]
pub struct DeliveriesFilter {
    /// Only deliveries with this status: pending, delivered or failed.
    #[arg(long, value_name = "STATUS")]
    pub status: Option<String>,
    /// Rows per page (max 200).
    #[arg(long, value_name = "N", value_parser = clap::value_parser!(u32).range(1..=200))]
    pub limit: Option<u32>,
    /// Continue from next_cursor.
    #[arg(long)]
    pub cursor: Option<String>,
}

/// Which deliveries a replay re-queues: ids, or every failed one.
#[derive(Debug, Args)]
pub struct ReplaySelection {
    /// Delivery ids (max 100).
    #[arg(required_unless_present = "failed")]
    pub ids: Vec<String>,
    /// Replay every failed delivery instead (the oldest first, at most 100 per call).
    #[arg(long, conflicts_with = "ids")]
    pub failed: bool,
    /// With --failed: only deliveries created since this RFC 3339 time.
    #[arg(long, value_name = "TIME", requires = "failed")]
    pub since: Option<String>,
    /// Idempotency key; reuse it when retrying so the deliveries are re-queued once [default: random].
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Args)]
pub struct RequestArgs {
    #[command(subcommand)]
    pub command: RequestCommand,
}

#[derive(Debug, Subcommand)]
pub enum RequestCommand {
    /// Check (or wait for) the custodian's decision on a self-created Silicon.
    ///
    /// The request token saved by `accounts silicon create` in {home}/.accounts/requests/ is used automatically; pass --token otherwise.
    #[command(
        after_long_help = "Examples:\n  accounts silicon request status 0192f0c2-…\n  accounts silicon request status 0192f0c2-… --wait --timeout 2h"
    )]
    Status {
        /// The request id.
        request_id: String,
        /// Keep polling until the custodian decides.
        #[arg(long)]
        wait: bool,
        /// Give up waiting after this long.
        #[arg(long, value_name = "DURATION", value_parser = duration_arg, default_value = "14d")]
        timeout: Duration,
        /// The request token (sarq_…), when it isn't saved locally.
        #[arg(long, value_name = "TOKEN")]
        token: Option<String>,
    },
}

#[derive(Debug, Args)]
pub struct OwnWebhookArgs {
    #[command(subcommand)]
    pub command: OwnWebhookCommand,
}

#[derive(Debug, Subcommand)]
pub enum OwnWebhookCommand {
    /// Set your webhook endpoint (prints the signing secret once).
    Set {
        /// The https endpoint.
        // Not named `url`: that id is the global --url flag (see SiliconWebhookCommand::Set).
        #[arg(value_name = "URL")]
        endpoint: String,
    },
    /// Remove your webhook endpoint.
    Remove,
    /// Send a test `ping` delivery.
    Test,
    /// List your webhook's deliveries, newest first (failed ones can be replayed).
    #[command(
        after_long_help = "Examples:\n  accounts webhook deliveries\n  accounts webhook deliveries --status failed --json"
    )]
    Deliveries {
        #[command(flatten)]
        filter: DeliveriesFilter,
    },
    /// Show one delivery with its attempts and the exact payload that was signed.
    Delivery {
        /// The delivery id.
        id: String,
    },
    /// Re-queue deliveries (same event id, sent to your current URL and signed with your current secret).
    ///
    /// Name the deliveries by id, or replay every failed one with --failed (at most 100 per call; run it again while `remaining` is above 0). Test pings are never replayed: send a new one with `accounts webhook test`.
    #[command(
        after_long_help = "Examples:\n  accounts webhook replay --failed\n  accounts webhook replay --failed --since 2026-10-01T00:00:00Z\n  accounts webhook replay 0192f0c2-… 0192f0c3-…"
    )]
    Replay {
        #[command(flatten)]
        selection: ReplaySelection,
    },
}

#[derive(Debug, Args)]
pub struct CustodianArgs {
    #[command(subcommand)]
    pub command: CustodianCommand,
}

#[derive(Debug, Subcommand)]
pub enum CustodianCommand {
    /// List custodian requests waiting for you.
    Requests,
    /// Accept a request: you become the Silicon's custodian.
    Accept {
        /// The request id.
        id: String,
    },
    /// Decline a request.
    Decline {
        /// The request id.
        id: String,
    },
}

// ---- app mode ------------------------------------------------------------------------------

#[derive(Debug, Args)]
pub struct AppArgs {
    /// The app id [env: ACCOUNTS_APP_ID; default: the app chosen with `accounts app use`].
    #[arg(
        long,
        global = true,
        value_name = "APP_ID",
        help_heading = "App credentials"
    )]
    pub app_id: Option<String>,

    /// The app secret (prefer --app-secret-stdin or ACCOUNTS_APP_SECRET).
    #[arg(
        long,
        global = true,
        value_name = "SECRET",
        help_heading = "App credentials"
    )]
    pub app_secret: Option<String>,

    /// Read the app secret from stdin.
    #[arg(long, global = true, help_heading = "App credentials")]
    pub app_secret_stdin: bool,

    #[command(subcommand)]
    pub command: AppCommand,
}

#[derive(Debug, Subcommand)]
pub enum AppCommand {
    /// Choose the app for later `accounts app` commands and store its secret (0600).
    ///
    /// Without a secret, later commands act as the app's owner through your session (you must be signed in as the Carbon who owns it).
    #[command(
        after_long_help = "Examples:\n  printf '%s' \"$SECRET\" | accounts app use briefcase --secret-stdin\n  accounts app use briefcase          (as its owner)"
    )]
    Use {
        /// The app id.
        app_id: String,
        /// Read the app secret from stdin.
        #[arg(long)]
        secret_stdin: bool,
        /// The app secret (prefer --secret-stdin).
        #[arg(long, value_name = "SECRET", conflicts_with = "secret_stdin")]
        secret: Option<String>,
    },
    /// List the apps you own (signed in as a Carbon).
    List,
    /// Make a new app: apps are created in Silicon Apps (opens it).
    New {
        /// Only print the link.
        #[arg(long)]
        no_browser: bool,
    },
    /// Show the app, its sign-in setup and user base stats.
    Show,
    /// The app's sign-in setup: methods, Google/Apple, branding, required details, redirect URIs.
    Config(AppConfigArgs),
    /// List the app's user base.
    Users(UsersArgs),
    /// Show one account in the user base, with its last sign-ins.
    User {
        /// The account uuid.
        uuid: String,
    },
    /// Import existing users (CSV or JSON), or inspect import jobs.
    Import(ImportArgs),
    /// Token endpoint calls: exchange codes and SLTs, refresh, introspect, revoke, verify.
    Token(TokenArgs),
    /// Fetch userinfo with an access token issued to this app.
    Userinfo {
        /// The access token (or - to read it from stdin).
        access_token: String,
    },
    /// OBO and ATA proofs: issue, verify, refresh, revoke, list.
    Proof(ProofArgs),
    /// The app's webhook: endpoint, secret, test, deliveries, replay.
    Webhook(AppWebhookArgs),
    /// Look up an account by uuid or id with the app's credentials.
    Lookup {
        /// uuid, c:id or si:id.
        target: String,
    },
}

#[derive(Debug, Args)]
pub struct AppConfigArgs {
    #[command(subcommand)]
    pub command: AppConfigCommand,
}

#[derive(Debug, Subcommand)]
pub enum AppConfigCommand {
    /// Print the sign-in setup as JSON (secrets masked).
    Get,
    /// Apply a JSON patch (deep merge, arrays replace) from a file or stdin (-).
    ///
    /// Validation errors list every bad field. Pass --expected-version (from `config get`) to refuse overwriting someone else's change.
    #[command(
        after_long_help = "Examples:\n  accounts app config set patch.json --expected-version 7\n  echo '{\"required_fields\":[\"email\"],\"branding\":{\"radius\":12}}' | accounts app config set -"
    )]
    Set {
        /// JSON file with the patch, or - for stdin.
        file: PathBuf,
        /// Fail if the setup changed since this version.
        #[arg(long, value_name = "N")]
        expected_version: Option<i64>,
        /// Idempotency key [default: random].
        #[arg(long, value_name = "KEY")]
        idempotency_key: Option<String>,
    },
    /// Show the history of sign-in setup changes.
    History {
        /// Entries per page.
        #[arg(long, value_name = "N")]
        limit: Option<u32>,
        /// Continue from next_cursor.
        #[arg(long)]
        cursor: Option<String>,
    },
}

#[derive(Debug, Args)]
pub struct UsersArgs {
    /// Search id, display name, email, phone and external id.
    #[arg(long, value_name = "TEXT")]
    pub q: Option<String>,
    /// active, access_removed, imported or deleted.
    #[arg(long, value_name = "STATUS")]
    pub status: Option<String>,
    /// carbon or silicon.
    #[arg(long, value_name = "KIND")]
    pub kind: Option<String>,
    /// signin, slt or import.
    #[arg(long, value_name = "SOURCE")]
    pub source: Option<String>,
    /// Rows per page (max 200).
    #[arg(long, value_name = "N", value_parser = clap::value_parser!(u32).range(1..=200))]
    pub limit: Option<u32>,
    /// Continue from next_cursor.
    #[arg(long)]
    pub cursor: Option<String>,
}

#[derive(Debug, Args)]
#[command(args_conflicts_with_subcommands = true)]
pub struct ImportArgs {
    #[command(subcommand)]
    pub command: Option<ImportCommand>,

    /// CSV or JSON file to import (- for stdin): at most 50 MB and 100,000 rows.
    #[arg(value_name = "FILE")]
    pub file: Option<PathBuf>,

    /// File format [default: from the extension; csv for stdin].
    #[arg(long, value_enum)]
    pub format: Option<ImportFormat>,

    /// Country for local phone numbers (ISO code, e.g. US).
    #[arg(long, value_name = "CC")]
    pub default_country: Option<String>,

    /// Validate and report without writing anything.
    #[arg(long)]
    pub dry_run: bool,

    /// Import even when the file has unknown columns (affected rows get a warning).
    #[arg(long)]
    pub ignore_unknown_columns: bool,

    /// Also refresh the imported profile of existing members.
    #[arg(long)]
    pub update_existing: bool,

    /// Wait for the job to finish, showing progress and the first errors.
    #[arg(long)]
    pub wait: bool,

    /// Idempotency key; reuse it when retrying an upload [default: random].
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Copy, ValueEnum, PartialEq, Eq)]
pub enum ImportFormat {
    Csv,
    Json,
}

#[derive(Debug, Subcommand)]
pub enum ImportCommand {
    /// Show an import job (add --wait to follow it).
    Status {
        /// The job id.
        job: String,
        /// Wait until it finishes.
        #[arg(long)]
        wait: bool,
    },
    /// Show per-row outcomes of an import job.
    Rows {
        /// The job id.
        job: String,
        /// Only rows with this outcome: created, matched, updated, skipped, error or pending.
        #[arg(long, value_name = "OUTCOME")]
        outcome: Option<String>,
        /// Only rows with a message of this level: error, warning or info.
        #[arg(long, value_name = "LEVEL")]
        level: Option<String>,
        /// Only rows with a message of this code, e.g. id_conflict or missing_identifier.
        #[arg(long, value_name = "CODE")]
        code: Option<String>,
        /// Rows per page (max 200).
        #[arg(long, value_name = "N")]
        limit: Option<u32>,
        /// Continue from next_cursor.
        #[arg(long)]
        cursor: Option<String>,
    },
    /// List import jobs.
    List,
}

#[derive(Debug, Args)]
pub struct TokenArgs {
    #[command(subcommand)]
    pub command: TokenCommand,
}

#[derive(Debug, Subcommand)]
pub enum TokenCommand {
    /// Exchange an authorization code from your redirect URI.
    Exchange {
        /// The code from ?code=.
        #[arg(long, value_name = "CODE")]
        code: String,
        /// The redirect URI used for /authorize (must match exactly).
        #[arg(long, value_name = "URI")]
        redirect_uri: String,
        /// The PKCE verifier, if you sent a challenge.
        // A verifier is random base64url, so one in 64 starts with "-": it is still the value, never a flag.
        #[arg(long, value_name = "VERIFIER", allow_hyphen_values = true)]
        code_verifier: Option<String>,
    },
    /// Exchange a Silicon's short-lived token (slt_…).
    Slt {
        /// The SLT (or - for stdin).
        slt: String,
    },
    /// Rotate a refresh token (store the new one).
    Refresh {
        /// The refresh token (or - for stdin).
        refresh_token: String,
    },
    /// Ask whether a token of this app is active.
    Introspect {
        /// The token (or - for stdin).
        token: String,
    },
    /// Revoke a token's family (signs the account out of the app).
    Revoke {
        /// The token (or - for stdin).
        token: String,
    },
    /// Verify an access token locally with the JWKS (exit 0 valid, 2 invalid).
    Verify {
        /// The access token (or - for stdin).
        access_token: String,
    },
}

#[derive(Debug, Args)]
pub struct ProofArgs {
    #[command(subcommand)]
    pub command: ProofCommand,
}

#[derive(Debug, Subcommand)]
pub enum ProofCommand {
    /// Issue an OBO proof: act at another app on behalf of an account that consented in your app.
    #[command(
        after_long_help = "Examples:\n  accounts app proof obo --subject-token \"$ACCESS_TOKEN\" --to briefcase \\\n      --scope files.write --ttl 600"
    )]
    Obo {
        /// The account's access token issued to this app (or - for stdin).
        #[arg(long, value_name = "TOKEN")]
        subject_token: String,
        /// The receiving app id.
        #[arg(long, value_name = "APP_ID")]
        to: String,
        /// App-defined scope (repeatable).
        #[arg(long = "scope", value_name = "SCOPE")]
        scopes: Vec<String>,
        /// Proof token lifetime in seconds (60..=1800).
        #[arg(long, value_name = "SECONDS", value_parser = clap::value_parser!(u32).range(60..=1800))]
        ttl: Option<u32>,
        /// Idempotency key [default: random].
        #[arg(long, value_name = "KEY")]
        idempotency_key: Option<String>,
    },
    /// Issue an ATA proof that one other app can verify (one proof per app).
    #[command(
        long_about = "Issue an ATA (app to app) proof: a token that proves to exactly one other app that a request really comes from this app. The receiving app checks it with `accounts app proof verify` (or POST /v1/proofs/verify). An ATA proof is always for one app: to talk to several apps, issue one proof per app, and each app verifies its own. Owners can also make, see and revoke ATA proofs on the app's ATA page at developers.teamofsilicons.com.",
        after_long_help = "Examples:\n  accounts app proof ata --to remind --ttl 300\n  accounts app proof ata --to waveform --scope notifications.send\n  accounts app proof list --kind ata"
    )]
    Ata {
        /// The one receiving app id (issue one proof per app).
        #[arg(long, value_name = "APP_ID", required = true)]
        to: String,
        /// App-defined scope (repeatable).
        #[arg(long = "scope", value_name = "SCOPE")]
        scopes: Vec<String>,
        /// Proof token lifetime in seconds (60..=1800).
        #[arg(long, value_name = "SECONDS", value_parser = clap::value_parser!(u32).range(60..=1800))]
        ttl: Option<u32>,
        /// Idempotency key [default: random].
        #[arg(long, value_name = "KEY")]
        idempotency_key: Option<String>,
    },
    /// Verify a proof token as this app: exit 0 when valid, 2 when not.
    #[command(
        after_long_help = "Examples:\n  accounts app proof verify sap_… --json\n  accounts app proof verify - < token.txt && echo valid"
    )]
    Verify {
        /// The proof token (or - for stdin).
        token: String,
    },
    /// Get a new proof token with the proof refresh token (it rotates).
    Refresh {
        /// The proof refresh token sapr_… (or - for stdin).
        refresh_token: String,
        /// New proof token lifetime in seconds (60..=1800).
        #[arg(long, value_name = "SECONDS", value_parser = clap::value_parser!(u32).range(60..=1800))]
        ttl: Option<u32>,
    },
    /// Revoke a proof this app issued (by id, proof token or refresh token).
    Revoke {
        /// The proof id.
        #[arg(required_unless_present_any = ["token", "refresh_token"])]
        proof_id: Option<String>,
        /// Revoke by proof token instead.
        #[arg(long, value_name = "TOKEN", conflicts_with_all = ["proof_id", "refresh_token"])]
        token: Option<String>,
        /// Revoke by proof refresh token instead.
        #[arg(long, value_name = "TOKEN", conflicts_with = "proof_id")]
        refresh_token: Option<String>,
    },
    /// List proofs this app issued.
    List {
        /// obo or ata.
        #[arg(long, value_name = "KIND")]
        kind: Option<String>,
        /// active or revoked.
        #[arg(long, value_name = "STATUS")]
        status: Option<String>,
        /// Rows per page.
        #[arg(long, value_name = "N")]
        limit: Option<u32>,
        /// Continue from next_cursor.
        #[arg(long)]
        cursor: Option<String>,
    },
}

#[derive(Debug, Args)]
pub struct AppWebhookArgs {
    #[command(subcommand)]
    pub command: AppWebhookCommand,
}

#[derive(Debug, Subcommand)]
pub enum AppWebhookCommand {
    /// Set the endpoint (a new signing secret is printed once).
    ///
    /// A retry with the same --idempotency-key (within 10 minutes) prints the same secret instead of generating another.
    Set {
        /// The endpoint URL.
        // Not named `url`: that id is the global --url flag (see SiliconWebhookCommand::Set).
        #[arg(value_name = "URL")]
        endpoint: String,
        /// Idempotency key [default: random].
        #[arg(long, value_name = "KEY")]
        idempotency_key: Option<String>,
    },
    /// Remove the endpoint.
    Remove,
    /// Rotate the signing secret (printed once; the old one stops immediately).
    ///
    /// A retry with the same --idempotency-key (within 10 minutes) prints the same new secret instead of rotating again.
    Rotate {
        /// Idempotency key [default: random].
        #[arg(long, value_name = "KEY")]
        idempotency_key: Option<String>,
    },
    /// Queue a test `ping` delivery (a retry with the same --idempotency-key queues no second ping).
    Test {
        /// Idempotency key [default: random].
        #[arg(long, value_name = "KEY")]
        idempotency_key: Option<String>,
    },
    /// List deliveries.
    Deliveries {
        /// pending, delivered or failed.
        #[arg(long, value_name = "STATUS")]
        status: Option<String>,
        /// Rows per page.
        #[arg(long, value_name = "N")]
        limit: Option<u32>,
        /// Continue from next_cursor.
        #[arg(long)]
        cursor: Option<String>,
    },
    /// Show one delivery with its attempts and payload.
    Delivery {
        /// The delivery id.
        id: String,
    },
    /// Re-queue deliveries (same event id, current URL and secret).
    #[command(
        after_long_help = "Examples:\n  accounts app webhook replay 0192f0c2-… 0192f0c3-…\n  accounts app webhook replay --failed --since 2026-10-01T00:00:00Z"
    )]
    Replay {
        /// Delivery ids (max 100).
        #[arg(required_unless_present = "failed")]
        ids: Vec<String>,
        /// Replay every failed delivery instead.
        #[arg(long, conflicts_with = "ids")]
        failed: bool,
        /// With --failed: only deliveries created since this RFC 3339 time.
        #[arg(long, value_name = "TIME", requires = "failed")]
        since: Option<String>,
        /// Idempotency key [default: random].
        #[arg(long, value_name = "KEY")]
        idempotency_key: Option<String>,
    },
}

// ---- config, report, docs ------------------------------------------------------------------

#[derive(Debug, Args)]
pub struct ConfigArgs {
    #[command(subcommand)]
    pub command: ConfigCommand,
}

#[derive(Debug, Subcommand)]
pub enum ConfigCommand {
    /// Show or set the home directory that holds .accounts/ (errors if it is not a directory).
    ///
    /// The setting is a pointer file in $SILICON_HOME/.accounts/home (or ~/.accounts/home). --home and ACCOUNTS_HOME still take precedence.
    #[command(
        after_long_help = "Examples:\n  accounts config home\n  accounts config home /srv/silicons/scout\n  accounts config home --reset"
    )]
    Home {
        /// The directory (must exist).
        dir: Option<PathBuf>,
        /// Forget the configured home.
        #[arg(long, conflicts_with = "dir")]
        reset: bool,
    },
    /// Show settings and where each value comes from.
    Get {
        /// One key: url, telemetry, home, app.
        key: Option<String>,
    },
    /// Set a setting in config.json: url <URL> or telemetry on|off.
    Set {
        /// url or telemetry.
        key: String,
        /// The value.
        value: String,
    },
    /// Remove a setting from config.json: url, telemetry or app.
    Unset {
        /// url, telemetry or app.
        key: String,
    },
    /// Turn telemetry on or off (it is on by default).
    ///
    /// Telemetry sends self-contained events about CLI steps (command, outcome, timing; never tokens, ids or contact details). ACCOUNTS_TELEMETRY=0 also turns it off.
    Telemetry {
        /// on or off.
        state: OnOff,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum, PartialEq, Eq)]
pub enum OnOff {
    On,
    Off,
}

#[derive(Debug, Args)]
pub struct ReportArgs {
    /// What happened (or - to read it from stdin).
    pub message: String,
    /// Link to a PR that fixes it.
    #[arg(long, value_name = "PR_URL")]
    pub pr: Option<String>,
    /// Don't append the CLI version and OS to the report.
    #[arg(long)]
    pub no_diagnostics: bool,
    /// Idempotency key [default: random].
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Args)]
pub struct DocsArgs {
    /// The topic (run without one to list them).
    pub topic: Option<String>,
}

#[derive(Debug, Args)]
pub struct HelpArgs {
    /// A command path (silicon create) or a docs topic (imports); a command wins over a topic of the same name.
    pub topic: Vec<String>,
}
