---
title: silicon-accounts CLI reference
description: Every silicon-accounts command, flag, environment variable and exit code, with examples for reading results and handling failures in scripts.
kind: informative
order: 69
related:
  - start/cli.md
  - start/silicon-account.md
  - start/silicon-sign-in-to-apps.md
  - start/custodians.md
  - reference/rust-client.md
  - reference/errors.md
---

# silicon-accounts CLI reference

This is every command in `silicon-accounts` 0.3.1. The [command sections](#commands) are taken from the CLI's own `--help`, so run `silicon-accounts <command> --help` to check the options in the version you have installed.

If this is your first time with the CLI, start with [Use the silicon-accounts CLI](../start/cli.md).

```sh
silicon-accounts --help                 # everything: the command tree, bundled guides, environment, exit codes
silicon-accounts silicon create --help  # one command: what it does, its options, examples
silicon-accounts --json                 # the command tree as JSON: {"commands":[{"command","about"},…]}
```

```text
accounts [OPTIONS] [COMMAND]
```

Run with no command, `silicon-accounts` prints the full help and exits `0`. A command group with no
subcommand (`silicon-accounts silicon`) prints its help and exits `2`.

## Global options

Every command takes these, before or after the command name.

| option | meaning |
|---|---|
| `--json` | Print machine-readable JSON on stdout, errors included. See [Output](#output). |
| `--url <URL>` | The Silicon Accounts URL. See [URL resolution](#url-resolution). |
| `--home <DIR>` | The directory that holds `.accounts/`. See [Home directory](#home-directory). |
| `-q`, `--quiet` | No progress, notices or next-step suggestions; results and errors still print. |
| `-h`, `--help` | Help: `-h` a summary, `--help` the full text with examples. |
| `-V`, `--version` | Print the version (`silicon-accounts 0.3.0`). |

`silicon-accounts app` commands also take `--app-id <APP_ID>`, `--app-secret <SECRET>` and
`--app-secret-stdin`; see [`silicon-accounts app`](#silicon-accounts-app).

## Environment variables

| variable | effect |
|---|---|
| `ACCOUNTS_URL` | the Silicon Accounts URL (default `https://accounts.teamofsilicons.com`) |
| `ACCOUNTS_HOME` | the directory holding `.accounts/`; beats the configured home |
| `SILICON_HOME` | the home when nothing else sets one (else `~`); also where `silicon-accounts config home` keeps its pointer file |
| `ACCOUNTS_SILICON`, `ACCOUNTS_STK` | a Silicon's si:id and STK for `silicon-accounts login` |
| `ACCOUNTS_SILICON_KEY` | a Silicon's private key file for `silicon-accounts login`, instead of the STK (see `silicon-accounts silicon keys`) |
| `ACCOUNTS_APP_ID` | the app for `silicon-accounts app …` |
| `ACCOUNTS_APP_SECRET` | that app's secret |
| `ACCOUNTS_TELEMETRY` | `0`, `false`, `no` or `off` turns telemetry off; `1`, `true`, `yes` or `on` turns it on; beats the config file |
| `ACCOUNTS_NO_BROWSER` | any value but `0` or empty: never open a browser (the device sign-in prints its URL instead) |
| `ACCOUNTS_TIMEOUT_SECONDS` | request timeout in whole seconds (default 30, at least 1) |
| `ACCOUNTS_ALLOW_INSECURE_HTTP` | `1` allows plain `http://` to hosts other than this machine |
| `NO_COLOR` | no colours on stderr (colours are only used when stderr is a terminal) |
| `TZ` | the timezone `silicon-accounts silicon create` uses when `--timezone` is not given (else the system's, else UTC) |
| `HOSTNAME`, `COMPUTERNAME` | the machine name in the default sign-in label `silicon-accounts CLI on <host> (<os>)` |

## URL resolution

The first match wins:

1. `--url`;
2. `ACCOUNTS_URL`;
3. `url` in `{home}/.accounts/config.json` (`silicon-accounts config set url …`);
4. the URL of the stored session;
5. the URL of a code sign-in waiting for its code (`silicon-accounts login --email … --url …`);
6. `https://accounts.teamofsilicons.com`.

Plain `http://` is refused for any host but this machine (`localhost`, `*.localhost`,
`127.0.0.0/8`, `::1`) unless `ACCOUNTS_ALLOW_INSECURE_HTTP=1`, because STKs and tokens would
travel unencrypted. You get exit code `2` and error code `invalid_input` (`invalid_url` from
`silicon-accounts config set url`). A session belongs to the URL it was created at, so with
another URL, account commands answer `not_signed_in`. `silicon-accounts silicon request status`
reads a request at the URL it was created at, unless `--url` or `ACCOUNTS_URL` says otherwise.

## Home directory

The CLI keeps its state in `{home}/.accounts/`. The first match wins:

1. `--home <DIR>`;
2. `ACCOUNTS_HOME`;
3. the directory set with `silicon-accounts config home <DIR>`, stored as a one-line pointer file in
   `{base}/.accounts/home`, where `{base}` is `$SILICON_HOME` if set, else `~`;
4. `SILICON_HOME`;
5. `~`.

The chosen home must be an existing directory. If it isn't, the command fails before doing
anything, with exit code `2`, error code `not_a_directory`, and a message saying why and which
setting chose it: `not a directory: /srv/silicons/nope (it does not exist; set by SILICON_HOME)`.
`silicon-accounts config home` with no argument shows the home and where it came from; `--reset`
forgets the configured one.

| file in `{home}/.accounts/` | holds |
|---|---|
| `session.json` | the signed-in account, its access and refresh tokens and the URL they belong to |
| `session.lock` | the lock held while a session is refreshed or stored |
| `config.json` | `url`, `telemetry` and `app` |
| `apps/<app_id>.json` | an app secret stored by `silicon-accounts app use <app_id> --secret-stdin` |
| `requests/<request-id>.json` | the `sarq_` polling token of a Silicon self-created from this home |
| `login-challenge.json` | a code sign-in waiting for its code |
| `home` | (only in `{base}/.accounts/`) the pointer written by `silicon-accounts config home` |

Files are written atomically (a temporary file, then a rename) with mode 0600, in a directory with
mode 0700. Token refreshes happen under `session.lock`, so any number of processes can share one
home. That lock matters: refresh tokens rotate, and presenting one twice would end the session.
One home holds one session, so signing in as another account there signs the previous one out.

## Output

- **Results** go to stdout: text, or with `--json`, one JSON document.
- **Progress, notices, warnings and next steps** go to stderr. Next steps are a `Next:` block of
  commands, each with what it's for. `-q` hides all of these; `--json` hides all but warnings,
  which become one-line JSON objects (`{"warning":"…"}`).
- **Essential events**, the ones you must see before a command finishes, go to stderr even with
  `-q`. With `--json` each is one JSON object per line: `{"event":"device_code","user_code",
  "verification_uri","verification_uri_complete","expires_at","browser_opened"}` from
  `silicon-accounts login`, and `{"event":"silicon_created",…}` (the whole creation, STK included) from
  `silicon-accounts silicon create --wait` before it starts waiting.
- **Timestamps** in `--json` output are RFC 3339 in UTC. They're meant to match the API's form,
  with exactly three fractional digits (`2026-10-07T02:33:45.489Z`), but today the values the CLI
  passes through the Rust client's types drop trailing zeros: the API's
  `2026-10-07T05:17:55.590Z` prints as `2026-10-07T05:17:55.59Z` in
  `silicon-accounts silicon list --json` (a known bug). Parse them as RFC 3339, and don't compare
  them as strings or assume a fixed width.

**Errors** print `error:`, `hint:`, any per-field problems and the request id on stderr. With
`--json` they print on stdout instead:

```json
{
  "error": {
    "code": "invalid_grant",
    "exit_code": 3,
    "hint": "Start a new sign-in. Codes and short-lived tokens are single-use and live 2 minutes; presenting an already-used refresh token revokes the whole token family, so sign in again.",
    "message": "The short-lived token was already used; each one works once. Get a new one.",
    "request_id": "01a11434-14f4-7710-a5df-4cdc49b7b130",
    "status": 400
  }
}
```

| field | always | meaning |
|---|---|---|
| `code` | yes | stable, machine-readable: branch on it |
| `message` | yes | what went wrong and why |
| `exit_code` | yes | the process exit code |
| `hint` | usually | what to do next |
| `status` | when the service answered | the HTTP status |
| `request_id` | when the service answered | quote it in bug reports |
| `details` | sometimes | specifics: `retry_after_seconds`, `suggestions`, `fields`, `missing`, … |

Argument errors (an unknown flag, a missing argument) exit `2` with code `invalid_arguments`.

## Exit codes

| code | meaning |
|---|---|
| `0` | success |
| `1` | failure: network, service error, unexpected response, local file problem |
| `2` | invalid input; also the "not valid" answer of a check |
| `3` | sign-in required, credentials refused, or not allowed |
| `4` | not found |
| `5` | conflict: already exists, taken, reserved, changed meanwhile |
| `6` | rate limited or locked; wait `details.retry_after_seconds` |
| `130` | interrupted with Ctrl-C |

Errors from the service map to exit codes by HTTP status: 400, 410, 413, 415 and 422 give `2`; 401
and 403 give `3`; 404 gives `4`; 409 gives `5`; 423 and 429 give `6`; anything else gives `1`.
OAuth errors map by name: `invalid_client`, `invalid_grant`, `access_denied`, `expired_token` and
`unauthorized_client` give `3`; `invalid_request`, `unsupported_grant_type` and `invalid_scope` give
`2`; `slow_down` gives `6`.

Some commands answer with their exit code, so a script can branch on it directly:

| command | exit codes |
|---|---|
| `silicon-accounts login status` | `0` for JSON; text mode: `0` signed in, `1` not |
| `silicon-accounts id available` | `0` available (or yours to take back), `5` taken, reserved or a reserved word, `2` not a valid id |
| `silicon-accounts app proof verify` | `0` valid, `2` not valid |
| `silicon-accounts app token verify`, `silicon-accounts app token introspect` | `0` valid or active, `2` not |
| `silicon-accounts silicon create --wait`, `silicon-accounts silicon request status --wait` | `0` accepted; `1` declined (`custodian_declined`), expired (`custodian_request_expired`), cancelled (`custodian_request_cancelled`) or timed out (`timed_out`); `130` interrupted, the request stays open |
| `silicon-accounts app import <FILE> --wait` | `1` when the job ended `failed` (`silicon-accounts app import status <JOB> --wait` exits `0` either way; read `status`) |

## CLI error codes

Most errors carry the service's code ([Errors](errors.md)) or the Rust client's
(`connection_failed`, `request_timeout`, `unexpected_response`, `invalid_input`, `timed_out`,
`token_*`: [Rust client codes](errors.md#rust-client-codes)). The codes below come from the CLI
itself, for problems it finds without asking the service:

| code | exit | when | what to do |
|---|---|---|---|
| `invalid_arguments` | `2` | an unknown flag, a missing argument, or a value a flag can't take (`silicon-accounts app users --limit abc`) | run the command with `--help` |
| `invalid_input` | `2` | a value the CLI checks before sending: an STK that isn't `stk-` plus 8 to 32 hex characters, a `c:` id where an si:id belongs, `--confirm` not matching, nothing on stdin where a secret was expected, an `http://` URL for another machine | fix what the message names |
| `file_not_found` | `2` | a file you named doesn't exist (`silicon-accounts app config set patch.json`) | check the path |
| `not_a_directory` | `2` | the home directory (`--home`, `ACCOUNTS_HOME`, `silicon-accounts config home`, `SILICON_HOME`) is a file or doesn't exist | point it at an existing directory, or `silicon-accounts config home --reset` |
| `invalid_url` | `2` | `silicon-accounts config set url` got a URL the CLI can't use | use `https://…` (or `http://` for this machine) |
| `io_error` | `1` | reading a file or stdin, or writing under `{home}/.accounts/`, failed | the message names the file; check it and its permissions |
| `corrupt_state_file` | `1` | a file under `{home}/.accounts/` isn't valid JSON | delete the file it names (you may have to sign in again) |
| `internal` | `1` | the CLI couldn't start or couldn't encode its own state | report it with `silicon-accounts report` |
| `not_signed_in` | `3` | no session for this URL, or a session for another URL | Carbons: `silicon-accounts login`; Silicons: `silicon-accounts login --silicon si:… --stk-stdin` |
| `session_ended` | `3` | the stored session was revoked, signed out elsewhere, or (a Silicon's) the STK was rotated | sign in again |
| `session_changed` | `3` | another command signed this home in as someone else while this one ran | run the command again |
| `wrong_account_kind` | `3` | the command is for the other kind of account (`silicon-accounts custodian requests` as a Silicon) | sign in as the kind the message names |
| `app_credentials_required` | `3` | an `silicon-accounts app` command has no app secret and you aren't signed in as a Carbon | `--app-secret-stdin`, `ACCOUNTS_APP_SECRET`, `silicon-accounts app use <app_id> --secret-stdin`, or sign in as the app's owner |
| `not_found` | `4` | `silicon-accounts silicon …` names a Silicon you aren't custodian of | `silicon-accounts silicon list` shows yours |
| `unknown_topic` | `4` | `silicon-accounts docs <topic>` names no topic | the hint lists the topics |
| `unknown_help_topic` | `4` | `silicon-accounts help <words>` is neither a command nor a topic | `silicon-accounts --help`, `silicon-accounts docs` |
| `custodian_declined`, `custodian_request_expired`, `custodian_request_cancelled`, `custodian_request_closed` | `1` | `--wait` on a self-created Silicon ended without an acceptance; the account was released | create it again, naming a Carbon who expects the request |
| `timed_out` | `1` | `--wait` gave up after `--timeout`; the custodian request stays open | resume with `silicon-accounts silicon request status <id> --wait` |
| `interrupted` | `130` | Ctrl-C while waiting (a device sign-in, a custodian's answer, an import) | the work goes on in the service; the message says how to resume |

```json
{
  "error": {
    "code": "wrong_account_kind",
    "exit_code": 3,
    "hint": "Sign in as a Carbon with `silicon-accounts login` (Silicons don't have this).",
    "message": "Custodian requests is for Carbon accounts, but you are signed in as Silicon si:scout."
  }
}
```

## Durations

`--timeout` takes a number with an optional unit: `90` or `90s`, `5m`, `2h`, `14d`, `1w` (also
`sec`, `secs`, `min`, `mins`, `hr`, `hrs`, `day`, `days`, `week`, `weeks`).

## Telemetry

While a command runs, the CLI buffers a few events. When the command ends, it sends them to
`POST /v1/telemetry/events`, waiting at most 1.5 seconds, and the service forwards them to Space
Station. Each event has `source: "cli"`, a `step`, a `progress` from 0 to 1, a `name` and a
`data` object:

- `cli.step` events for steps of multi-step flows: `login.silicon.started`, `login.code.sent`,
  `login.device.code_shown`, `login.device.approved`, `login.done`, `login.slt.issued`,
  `session.refreshed`, `silicon.create.custodian`, `silicon.create.requested`,
  `silicon.create.accepted`, `app.import.started`;
- one `cli.command` event per command with `outcome`, `exit_code`, `error_code`, `duration_ms`,
  `json` and `account_kind`.

Every `data` also carries `command`, `cli_version`, `os` and `arch`. Tokens, STKs, secrets,
account ids and uuids, and contact details are never sent; the only identifier is the app id in
`login.slt.issued`. Nothing is sent when a command never contacted the service or couldn't reach
it.

Telemetry is on by default. `silicon-accounts config telemetry off` (or `ACCOUNTS_TELEMETRY=0`)
turns it off, and then every request to the service also carries `X-Accounts-Telemetry: off`, so
the service records no telemetry about those requests either.

## Bug reports

`silicon-accounts report "<message>" [--pr <https link>]` sends `POST /v1/reports`, and every
report is emailed to the Silicon Accounts maintainers (3 recipients). The message is 1 to 10,000
characters (`-` reads it from stdin). A signed-in report names your account; a signed-out one is
anonymous. The CLI version, operating system and architecture are added unless you pass
`--no-diagnostics`. Reports are limited to 5 per hour per network. Say what you ran, what you
expected, what happened, and the request id. If you've already patched it, add the pull request
with `--pr` (we'd be grateful).

## Updates

Silicon Apps installs and updates the CLI. `silicon-accounts` never updates itself and never
checks for updates, because a second updater would only fight with Silicon Apps.

## Bundled guides

`silicon-accounts docs <topic>` prints a guide that ships inside the CLI. Topic names also accept
the aliases in brackets.

`silicon-accounts help <topic>` prints the same guide only when no command has that name, because a
command name wins. `proofs` and `apps` are also commands, and so are the aliases `login`,
`silicon`, `custodian`, `app`, `webhook`, `id` and `help`. So `silicon-accounts help proofs` prints
the help of `silicon-accounts proofs`, not the guide, while `silicon-accounts help imports` does
print the guide. To be sure you get a guide, use `silicon-accounts docs <topic>`.

| topic | what it covers |
|---|---|
| `getting-started` (`start`, `getting`, `intro`, `login`, `quickstart`) | sign in, check who you are, the first commands |
| `silicons` (`silicon`, `stk`) | how a Silicon gets an account, signs in, and signs into apps |
| `custodians` (`custodian`, `transfer`) | being a Silicon's custodian |
| `apps` (`app`, `sign-in`, `signin`, `oauth`, `tokens`) | adding sign-in to an app |
| `proofs` (`proof`, `app-verification`, `user-verification`) | User verification and App verification proofs |
| `webhooks` (`webhook`, `events`) | app and Silicon webhooks |
| `imports` (`import`) | bringing an app's existing users |
| `ids` (`id`, `uuid`, `identifiers`) | uuids, ids, reservations, membership ids |
| `troubleshooting` (`errors`, `exit-codes`, `help`) | exit codes and common errors |
| `links` (`link`, `repo`, `github`, `crate`) | the repository, online docs and the Rust package |

An unknown topic exits `4` with `unknown_topic` and lists the topics.

To prove your app to another app, use `silicon-accounts app proof app-verification`; to act for an account, use `silicon-accounts app proof user-verification`. `silicon-accounts proofs` lists the proofs issued on your behalf, and `accounts user-verification` is an alias for that list and its revoke command. The JSON kinds are `app_verification` and `user_verification`.

## Command tree

As `silicon-accounts --help` prints it:

```text
  accounts                                  Show this package's Silicon Accounts identity for
                                            Silicon Apps discovery
  login                                     Sign in as a Carbon or a Silicon, or get a short-lived
                                            token for an app
    login status                            Report whether you are signed in and as whom (JSON
                                            exits 0; text exits 1 when signed out)
  logout                                    Sign out: revoke this CLI session and delete the
                                            stored tokens
  whoami                                    Show the signed-in account (uuid, id, kind,
                                            custodian…)
  id                                        Check whether an id is available, or change your own
                                            c:id / si:id
    id available <ID>                       Check whether a c:id or si:id can be taken (exit 0
                                            available, 5 taken/reserved, 2 invalid)
    id change <NEW_ID>                      Change your own c:id / si:id (the prefix is added if
                                            you omit it)
  lookup <TARGET>                           Look up an account by uuid or by c:id / si:id
  profile                                   Show or edit your profile: display name, timezone,
                                            date of birth, photo
    profile show                            Show your full profile (same as `silicon-accounts
                                            whoami`)
    profile set                             Change profile fields; only the flags you pass change
  email                                     Manage your email addresses (Carbons): list, add +
                                            verify, make primary, remove
    email list                              List your email addresses
    email add <EMAIL>                       Add an email: sends a 6-digit code (asks for it when
                                            run in a terminal)
    email verify <CHALLENGE_ID> <CODE>      Confirm an added email with its code
    email primary <EMAIL>                   Make an email your primary one (apps with the email
                                            scope are told)
    email remove <EMAIL>                    Remove an email (not the primary one)
  phone                                     Manage your phone numbers (Carbons): list, add +
                                            verify, make primary, remove
    phone list                              List your phone numbers
    phone add <PHONE>                       Add a phone number: sends a 6-digit code by SMS
    phone verify <CHALLENGE_ID> <CODE>      Confirm an added number with its code
    phone primary <PHONE>                   Make a number your primary one
    phone remove <PHONE>                    Remove a number (not the primary one)
  identities                                List or unlink the Google / Apple identities linked to
                                            your account
    identities list                         List linked Google / Apple identities
    identities remove <PROVIDER> <SUBJECT>  Unlink an identity
  apps                                      Apps you signed into: list them, or remove an app's
                                            access
    apps list                               List the apps you signed into, with what you share
                                            with each
    apps remove <APP_ID>                    Remove an app's access to your account
  proofs                                    User verification proofs apps issued on your behalf:
                                            list or revoke them
    proofs list                             List User verification proofs issued on your behalf
    proofs revoke <PROOF_ID>                Revoke a User verification proof
  sessions                                  Your browser sessions and CLI sign-ins: list or revoke
                                            them
    sessions list                           List browser sessions and CLI sign-ins
    sessions revoke <ID>                    Revoke a session (it is signed out everywhere it is
                                            used)
  history                                   Your account history: sign-ins, id changes, custodian
                                            changes, proofs, app access
  silicon                                   Silicons: create one, manage the Silicons you are
                                            custodian of, check a request
    silicon create                          Create a Silicon account
    silicon list                            List the Silicons you are custodian of
    silicon show <SILICON>                  Show one of your Silicons (by si:id or uuid)
    silicon update <SILICON>                Change one of your Silicons' display name, timezone or
                                            photo (a URL, or upload a file)
    silicon id <SILICON> <NEW_ID>           Change one of your Silicons' si:id (apps it signed
                                            into are notified)
    silicon rotate-stk <SILICON>            Rotate a Silicon's STK: the old one stops working and
                                            its sessions are revoked
    silicon webhook                         One of your Silicons' webhook: set or remove the
                                            endpoint, see and replay its deliveries
      silicon webhook set <SILICON> <URL>   Set the endpoint (prints the signing secret once)
      silicon webhook remove <SILICON>      Remove the endpoint
      silicon webhook deliveries <SILICON>  List the deliveries of the Silicon's webhook, newest
                                            first
      silicon webhook delivery <SILICON> <ID>
                                            Show one delivery of the Silicon's webhook with its
                                            attempts and the exact payload
      silicon webhook replay <SILICON> [IDS]
                                            Re-queue deliveries of the Silicon's webhook (same
                                            event id, its current URL and secret)
    silicon apps                            The apps one of your Silicons signed into: list them,
                                            remove one, and choose which apps it may sign into
      silicon apps list <SILICON>           List the apps the Silicon signed into, most recently
                                            used first
      silicon apps remove <SILICON> <APP_ID>
                                            Remove the Silicon's access to one app (its sign-ins
                                            there end)
      silicon apps allow <SILICON> [APPS]   Set the apps the Silicon may get short-lived tokens
                                            for (replaces the list)
      silicon apps allowed <SILICON>        Show the apps the Silicon may get short-lived tokens
                                            for
    silicon keys                            A Silicon's keys: sign in with a key instead of the
                                            STK, so an unattended Silicon never holds a bearer
                                            secret
      silicon keys add <SILICON>            Register a key: generate a new one, or give a private
                                            or public key file
      silicon keys list <SILICON>           List a Silicon's keys (revoked ones too)
      silicon keys revoke <SILICON> <KEY_ID>
                                            Revoke a key: it stops working and the sign-ins it
                                            started end
    silicon signins <SILICON>               One of your Silicons' sign-ins, newest first (app,
                                            method, outcome, address)
    silicon transfer <SILICON>              Transfer a Silicon to another Carbon (they must accept
                                            within 14 days)
    silicon cancel-transfer <SILICON>       Cancel a pending transfer
    silicon delete <SILICON>                Delete one of your Silicons permanently
    silicon request                         A self-created Silicon's custodian request
      silicon request status <REQUEST_ID>   Check (or wait for) the custodian's decision on a
                                            self-created Silicon
  webhook                                   A Silicon's own webhook: get notified about your
                                            account (custodian decisions, STK rotations, changes),
                                            and see or replay its deliveries
    webhook set <URL>                       Set your webhook endpoint (prints the signing secret
                                            once)
    webhook remove                          Remove your webhook endpoint
    webhook test                            Send a test `ping` delivery
    webhook deliveries                      List your webhook's deliveries, newest first (failed
                                            ones can be replayed)
    webhook delivery <ID>                   Show one delivery with its attempts and the exact
                                            payload that was signed
    webhook replay [IDS]                    Re-queue deliveries (same event id, sent to your
                                            current URL and signed with your current secret)
  custodian                                 Custodian requests addressed to you (Carbons): list,
                                            accept, decline
    custodian requests                      List custodian requests waiting for you
    custodian accept <ID>                   Accept a request: you become the Silicon's custodian
    custodian decline <ID>                  Decline a request
  device                                    Approve or deny a CLI sign-in code shown on another
                                            machine (Carbons)
    device show <CODE>                      Show a pending CLI sign-in (label, status, expiry)
    device approve <CODE>                   Approve it: the other machine gets signed in as you
    device deny <CODE>                      Deny it
  app                                       App mode: an app's sign-in setup, user base, imports,
                                            tokens, webhooks and proofs
    app use <APP_ID>                        Choose the app for later `silicon-accounts app`
                                            commands and store its secret (0600)
    app list                                List the apps you own (signed in as a Carbon)
    app new                                 Make a new app: apps are created in Silicon Apps
                                            (opens it)
    app show                                Show the app, its sign-in setup and user base stats
    app config                              The app's sign-in setup: methods, Google/Apple,
                                            branding, required details, redirect URIs
      app config get                        Print the sign-in setup as JSON (secrets masked)
      app config set <FILE>                 Apply a JSON patch (deep merge, arrays replace) from a
                                            file or stdin (-)
      app config history                    Show the history of sign-in setup changes
    app users                               List the app's user base
    app user <UUID>                         Show one account in the user base, with its last
                                            sign-ins
    app import [FILE]                       Import existing users (CSV or JSON), or inspect import
                                            jobs
      app import status <JOB>               Show an import job (add --wait to follow it)
      app import rows <JOB>                 Show per-row outcomes of an import job
      app import list                       List import jobs
    app token                               Token endpoint calls: exchange codes and SLTs,
                                            refresh, introspect, revoke, verify
      app token exchange                    Exchange an authorization code from your redirect URI
      app token slt <SLT>                   Exchange a Silicon's short-lived token (slt_…)
      app token refresh <REFRESH_TOKEN>     Rotate a refresh token (store the new one)
      app token introspect <TOKEN>          Ask whether a token of this app is active
      app token revoke <TOKEN>              Revoke a token's family (signs the account out of the
                                            app)
      app token verify <ACCESS_TOKEN>       Verify an access token locally with the JWKS (exit 0
                                            valid, 2 invalid)
    app userinfo <ACCESS_TOKEN>             Fetch userinfo with an access token issued to this app
    app proof                               User verification and App verification proofs: issue,
                                            verify, refresh, revoke, list
      app proof user-verification           Issue a User verification proof: act at another app on
                                            behalf of an account that consented in your app
      app proof app-verification            Issue an app verification proof that one other app can
                                            verify (one proof per app)
      app proof verify <TOKEN>              Verify a proof token as this app: exit 0 when valid, 2
                                            when not
      app proof refresh <REFRESH_TOKEN>     Get a new proof token with the proof refresh token (it
                                            rotates)
      app proof revoke [PROOF_ID]           Revoke a proof this app issued (by id, proof token or
                                            refresh token)
      app proof list                        List proofs this app issued
    app webhook                             The app's webhook: endpoint, secret, test, deliveries,
                                            replay
      app webhook set <URL>                 Set the endpoint (a new signing secret is printed
                                            once)
      app webhook remove                    Remove the endpoint
      app webhook rotate                    Rotate the signing secret (printed once; the old one
                                            stops immediately)
      app webhook test                      Queue a test `ping` delivery (a retry with the same
                                            --idempotency-key queues no second ping)
      app webhook deliveries                List deliveries
      app webhook delivery <ID>             Show one delivery with its attempts and payload
      app webhook replay [IDS]              Re-queue deliveries (same event id, current URL and
                                            secret)
    app subscription                        Event subscriptions: where the app's updates go (its
                                            webhook or the event stream), which updates it wants,
                                            and whether each is active or paused
      app subscription list                 List the app's subscriptions
      app subscription show <ID>            Show one subscription
      app subscription create <DELIVERY> [URL]
                                            Create a subscription (a webhook's signing secret is
                                            printed once)
      app subscription update <ID>          Change a subscription: its updates, pause or resume
                                            it, or move a webhook (the secret stays)
      app subscription delete <ID>          Delete a subscription (deleting the webhook
                                            subscription removes the app's webhook)
      app subscription test <ID>            Queue a test `ping` on a subscription
    app lookup <TARGET>                     Look up an account by uuid or id with the app's
                                            credentials
  config                                    CLI settings: home directory, URL, telemetry
    config home [DIR]                       Show or set the home directory that holds .accounts/
                                            (errors if it is not a directory)
    config get [KEY]                        Show settings and where each value comes from
    config set <KEY> <VALUE>                Set a setting in config.json: url <URL> or telemetry
                                            on|off
    config unset <KEY>                      Remove a setting from config.json: url, telemetry or
                                            app
    config telemetry <STATE>                Turn telemetry on or off (it is on by default)
  report <MESSAGE>                          Report a bug to the Silicon Accounts maintainers,
                                            optionally with the PR that fixes it
  docs [TOPIC]                              Read the bundled docs (guides for Silicons, Carbons
                                            and apps)
  help [TOPIC]                              Help for a command (`silicon-accounts help silicon
                                            create`) or a docs topic (`silicon-accounts help
                                            imports`)
  delete-account                            Delete your account permanently (requires --confirm
                                            <your id>)
```

## Commands

Each section below comes from `silicon-accounts <command> --help`. Options marked `[env: …]` also
read that environment variable, and `[default: …]` is the value used when you leave the option
out. A few sections add a hand-written note after the generated part, such as what a deleted
account looks like in [`silicon-accounts app users`](#silicon-accounts-app-users).

### `silicon-accounts accounts`

Reports this package's identity. `silicon-accounts accounts --json` returns `app_id: silicon-accounts` without signing in. Silicon Apps uses it when validating the package, since every package in the store has to answer `accounts --json`.

### `silicon-accounts login`

Sign in as a Carbon or a Silicon, or get a short-lived token for an app.

Carbons sign in with a browser code (device flow) or with a 6-digit code sent to their email or phone. Silicons sign in with their si:id and STK. The session is stored in `{home}/.accounts/session.json` (mode 0600) and refreshed automatically.

With --app, prints a short-lived token (SLT, 2 minutes, single use) for that app; if you are already signed in it is returned directly. Hand the SLT to the app, which exchanges it for your tokens. This is how Silicons sign into apps. Check the session with `silicon-accounts login status --json`.

```text
silicon-accounts login [OPTIONS]
silicon-accounts login <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`status`](#silicon-accounts-login-status) | Report whether you are signed in and as whom (JSON exits 0; text exits 1 when signed out) |

| argument or option | meaning |
|---|---|
| `--silicon <SI_ID>` | Sign in as this Silicon (si:id) with its STK [env: ACCOUNTS_SILICON] |
| `--stk <STK>` | The Silicon's STK (prefer --stk-stdin or ACCOUNTS_STK: arguments are visible to other processes) |
| `--stk-stdin` | Read the STK from stdin |
| `--key <FILE>` | Sign the Silicon in with this private key file instead of its STK (a key registered with `silicon-accounts silicon keys add`) [env: ACCOUNTS_SILICON_KEY] |
| `--email <EMAIL>` | Carbon: send a 6-digit sign-in code to this email |
| `--phone <PHONE>` | Carbon: send a 6-digit sign-in code by SMS to this phone number |
| `--country <CC>` | Country for a local phone number (ISO code, e.g. IN, US) |
| `--challenge <CHALLENGE_ID>` | Finish a code sign-in started earlier (the challenge id it printed) |
| `--code <CODE>` | The 6-digit code you received (with --email/--phone/--challenge) |
| `--app <APP_ID>` | After signing in (or right away if already signed in), print a short-lived token for this app |
| `--no-browser` | Device flow: don't open a browser, just print the code and URL |
| `--label <TEXT>` | Label for this sign-in in your session list [default: silicon-accounts CLI on `<host>` (`<os>`)] |
| `--force` | Sign in again even if already signed in |

Examples, as `--help` prints them:

```text
silicon-accounts login                                   Carbon: browser code (device flow)
silicon-accounts login --no-browser                      print the code and URL only
silicon-accounts login --email saket@example.com         Carbon: code by email (prompts for it)
silicon-accounts login --email saket@example.com --code 123456
                                                 finish a code sent by an earlier call
printf '%s' "$STK" | silicon-accounts login --silicon si:scout --stk-stdin
ACCOUNTS_SILICON=si:scout ACCOUNTS_STK=stk-… silicon-accounts login --json
silicon-accounts login --app remind                      print a short-lived token for remind
silicon-accounts login status --json                     {"authenticated":true,"kind":"silicon",…}

Exit codes: 0 ok, 1 failure, 2 invalid input, 3 not signed in or credentials refused,
6 locked or rate limited.
```

#### `silicon-accounts login status`

Report whether you are signed in and as whom (JSON exits 0; text exits 1 when signed out).

Checks the stored session against the service (refreshing it if needed) unless --offline. JSON: `{"authenticated":true,"kind":"silicon","id":"si:scout","uuid":"…","expires_at":"…"}` or `{"authenticated":false}`.

```text
silicon-accounts login status [OPTIONS]
```

| argument or option | meaning |
|---|---|
| `--offline` | Only read the stored session; don't contact the service |

Examples, as `--help` prints them:

```text
silicon-accounts login status
silicon-accounts login status --json
silicon-accounts login status --offline --json
```

### `silicon-accounts logout`

Sign out: revoke this CLI session and delete the stored tokens.

Other sessions (the account site, other machines) stay signed in; see `silicon-accounts sessions list` to revoke those.

```text
silicon-accounts logout [OPTIONS]
```

Examples, as `--help` prints them:

```text
silicon-accounts logout
silicon-accounts logout --json
```

### `silicon-accounts whoami`

Show the signed-in account (uuid, id, kind, custodian…).

Calls GET /v1/me with the stored session. Use `silicon-accounts login status` for a quick check that also works offline.

```text
silicon-accounts whoami [OPTIONS]
```

Examples, as `--help` prints them:

```text
silicon-accounts whoami
silicon-accounts whoami --json | jq -r .uuid
```

### `silicon-accounts id`

Check whether an id is available, or change your own c:id / si:id.

The uuid never changes; the c:id or si:id can. After a change your old id stays reserved for you for 10 days (only you can take it back), and every app you signed into is notified, so apps keep working.

```text
silicon-accounts id [OPTIONS] <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`available`](#silicon-accounts-id-available) | Check whether a c:id or si:id can be taken (exit 0 available, 5 taken/reserved, 2 invalid) |
| [`change`](#silicon-accounts-id-change) | Change your own c:id / si:id (the prefix is added if you omit it) |

Examples, as `--help` prints them:

```text
silicon-accounts id available c:saket
silicon-accounts id available si:head_of_growth --json
silicon-accounts id change c:saket_dev
```

#### `silicon-accounts id available`

Check whether a c:id or si:id can be taken (exit 0 available, 5 taken/reserved, 2 invalid).

Ids are c: or si: plus 3 to 30 of a-z, 0-9, - and _ (case-insensitive). When signed in, an id reserved for you after a change shows as reclaimable. A custodian adds --for `<si:…>` to ask for one of its Silicons: an old id of that Silicon shows as reclaimable for it (take it back with `silicon-accounts silicon id`).

```text
silicon-accounts id available [OPTIONS] <ID>
```

| argument or option | meaning |
|---|---|
| `<ID>` | The id, e.g. c:saket or si:scout |
| `--for <SILICON>` | Ask for one of your Silicons (its si:id or uuid) instead of yourself |

Examples, as `--help` prints them:

```text
silicon-accounts id available c:saket
silicon-accounts id available si:scout --json
silicon-accounts id available si:scout --for si:scout_v2
```

#### `silicon-accounts id change`

Change your own c:id / si:id (the prefix is added if you omit it).

Your old id stays reserved for you for 10 days. Apps you signed into get account.id_changed; they key on your uuid, so nothing breaks.

```text
silicon-accounts id change [OPTIONS] <NEW_ID>
```

| argument or option | meaning |
|---|---|
| `<NEW_ID>` | The new id |

Examples, as `--help` prints them:

```text
silicon-accounts id change c:saket_dev
silicon-accounts id change scout_v2
```

### `silicon-accounts lookup`

Look up an account by uuid or by c:id / si:id.

Shows the public identity (uuid, id, kind, display name, status and a Silicon's custodian). Uses your session, or the app credentials when you are not signed in. Only current ids resolve; store uuids, not ids.

```text
silicon-accounts lookup [OPTIONS] <TARGET>
```

| argument or option | meaning |
|---|---|
| `<TARGET>` | A uuid (a8K) or an id (c:saket, si:scout) |

Examples, as `--help` prints them:

```text
silicon-accounts lookup c:saket
silicon-accounts lookup a8K --json
```

### `silicon-accounts profile`

Show or edit your profile: display name, timezone, date of birth, photo.

Apps that can see a changed field are notified with account.updated. A Silicon's date of birth is the day its account was created and can't be changed.

```text
silicon-accounts profile [OPTIONS] <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`show`](#silicon-accounts-profile-show) | Show your full profile (same as `silicon-accounts whoami`) |
| [`set`](#silicon-accounts-profile-set) | Change profile fields; only the flags you pass change |

Examples, as `--help` prints them:

```text
silicon-accounts profile show
silicon-accounts profile set --display-name "Saket" --timezone Asia/Kolkata
silicon-accounts profile set --photo ./me.png
silicon-accounts profile set --reset-photo
```

#### `silicon-accounts profile show`

Show your full profile (same as `silicon-accounts whoami`)

```text
silicon-accounts profile show [OPTIONS]
```

#### `silicon-accounts profile set`

Change profile fields; only the flags you pass change

```text
silicon-accounts profile set [OPTIONS]
```

| argument or option | meaning |
|---|---|
| `--display-name <NAME>` | New display name (1 to 100 characters) |
| `--timezone <TZ>` | New timezone (IANA name, e.g. Asia/Kolkata) |
| `--dob <YYYY-MM-DD>` | New date of birth, YYYY-MM-DD (Carbons only) |
| `--pfp-url <URL>` | New profile photo URL (https) |
| `--photo <FILE>` | Upload a profile photo (PNG, JPEG, WebP or GIF, at most 2 MB) |
| `--reset-photo` | Go back to the default profile photo |

Examples, as `--help` prints them:

```text
silicon-accounts profile set --display-name "Saket"
silicon-accounts profile set --timezone Europe/Berlin --dob 1999-04-01
silicon-accounts profile set --photo ./avatar.png
```

### `silicon-accounts email`

Manage your email addresses (Carbons): list, add + verify, make primary, remove.

Up to 10 emails; any of them signs you in. Adding sends a 6-digit code (valid 10 minutes) that you confirm with `silicon-accounts email verify`. The primary email can't be removed: make another one primary first.

```text
silicon-accounts email [OPTIONS] <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`list`](#silicon-accounts-email-list) | List your email addresses |
| [`add`](#silicon-accounts-email-add) | Add an email: sends a 6-digit code (asks for it when run in a terminal) |
| [`verify`](#silicon-accounts-email-verify) | Confirm an added email with its code |
| [`primary`](#silicon-accounts-email-primary) | Make an email your primary one (apps with the email scope are told) |
| [`remove`](#silicon-accounts-email-remove) | Remove an email (not the primary one) |

Examples, as `--help` prints them:

```text
silicon-accounts email list
silicon-accounts email add work@example.com
silicon-accounts email verify 0192f0c2-… 123456
silicon-accounts email primary work@example.com
silicon-accounts email remove old@example.com
```

#### `silicon-accounts email list`

List your email addresses

```text
silicon-accounts email list [OPTIONS]
```

#### `silicon-accounts email add`

Add an email: sends a 6-digit code (asks for it when run in a terminal)

```text
silicon-accounts email add [OPTIONS] <EMAIL>
```

| argument or option | meaning |
|---|---|
| `<EMAIL>` | The email address |

#### `silicon-accounts email verify`

Confirm an added email with its code

```text
silicon-accounts email verify [OPTIONS] <CHALLENGE_ID> <CODE>
```

| argument or option | meaning |
|---|---|
| `<CHALLENGE_ID>` | The challenge id printed by `silicon-accounts email add` |
| `<CODE>` | The 6-digit code |

#### `silicon-accounts email primary`

Make an email your primary one (apps with the email scope are told)

```text
silicon-accounts email primary [OPTIONS] <EMAIL>
```

| argument or option | meaning |
|---|---|
| `<EMAIL>` | The email address |

#### `silicon-accounts email remove`

Remove an email (not the primary one)

```text
silicon-accounts email remove [OPTIONS] <EMAIL>
```

| argument or option | meaning |
|---|---|
| `<EMAIL>` | The email address |

### `silicon-accounts phone`

Manage your phone numbers (Carbons): list, add + verify, make primary, remove.

Works exactly like `silicon-accounts email`. Numbers are stored in E.164 (+919876543210); pass --country for local formats.

```text
silicon-accounts phone [OPTIONS] <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`list`](#silicon-accounts-phone-list) | List your phone numbers |
| [`add`](#silicon-accounts-phone-add) | Add a phone number: sends a 6-digit code by SMS |
| [`verify`](#silicon-accounts-phone-verify) | Confirm an added number with its code |
| [`primary`](#silicon-accounts-phone-primary) | Make a number your primary one |
| [`remove`](#silicon-accounts-phone-remove) | Remove a number (not the primary one) |

Examples, as `--help` prints them:

```text
silicon-accounts phone add +919876543210
silicon-accounts phone add 98765 43210 --country IN
silicon-accounts phone verify 0192f0c2-… 123456
```

#### `silicon-accounts phone list`

List your phone numbers

```text
silicon-accounts phone list [OPTIONS]
```

#### `silicon-accounts phone add`

Add a phone number: sends a 6-digit code by SMS

```text
silicon-accounts phone add [OPTIONS] <PHONE>
```

| argument or option | meaning |
|---|---|
| `<PHONE>` | The number (E.164 like +919876543210, or local with --country) |
| `--country <CC>` | Country for a local number (ISO code, e.g. IN) |

#### `silicon-accounts phone verify`

Confirm an added number with its code

```text
silicon-accounts phone verify [OPTIONS] <CHALLENGE_ID> <CODE>
```

| argument or option | meaning |
|---|---|
| `<CHALLENGE_ID>` | The challenge id printed by `silicon-accounts phone add` |
| `<CODE>` | The 6-digit code |

#### `silicon-accounts phone primary`

Make a number your primary one

```text
silicon-accounts phone primary [OPTIONS] <PHONE>
```

| argument or option | meaning |
|---|---|
| `<PHONE>` | The number |

#### `silicon-accounts phone remove`

Remove a number (not the primary one)

```text
silicon-accounts phone remove [OPTIONS] <PHONE>
```

| argument or option | meaning |
|---|---|
| `<PHONE>` | The number |

### `silicon-accounts identities`

List or unlink the Google / Apple identities linked to your account

```text
silicon-accounts identities [OPTIONS] <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`list`](#silicon-accounts-identities-list) | List linked Google / Apple identities |
| [`remove`](#silicon-accounts-identities-remove) | Unlink an identity |

Examples, as `--help` prints them:

```text
silicon-accounts identities list
silicon-accounts identities remove google 1098765432
```

#### `silicon-accounts identities list`

List linked Google / Apple identities

```text
silicon-accounts identities list [OPTIONS]
```

#### `silicon-accounts identities remove`

Unlink an identity

```text
silicon-accounts identities remove [OPTIONS] <PROVIDER> <SUBJECT>
```

| argument or option | meaning |
|---|---|
| `<PROVIDER>` | google or apple |
| `<SUBJECT>` | The provider's subject id (from `silicon-accounts identities list`) |

### `silicon-accounts apps`

Apps you signed into: list them, or remove an app's access.

Removing access revokes the app's tokens for you and the User verification proofs it issued about you, and tells the app (membership.access_removed).

```text
silicon-accounts apps [OPTIONS] <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`list`](#silicon-accounts-apps-list) | List the apps you signed into, with what you share with each |
| [`remove`](#silicon-accounts-apps-remove) | Remove an app's access to your account |

Examples, as `--help` prints them:

```text
silicon-accounts apps list
silicon-accounts apps remove briefcase
```

#### `silicon-accounts apps list`

List the apps you signed into, with what you share with each

```text
silicon-accounts apps list [OPTIONS]
```

#### `silicon-accounts apps remove`

Remove an app's access to your account

```text
silicon-accounts apps remove [OPTIONS] <APP_ID>
```

| argument or option | meaning |
|---|---|
| `<APP_ID>` | The app id, e.g. briefcase |

### `silicon-accounts proofs`

User verification proofs apps issued on your behalf: list or revoke them

```text
silicon-accounts proofs [OPTIONS] <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`list`](#silicon-accounts-proofs-list) | List User verification proofs issued on your behalf |
| [`revoke`](#silicon-accounts-proofs-revoke) | Revoke a User verification proof |

Examples, as `--help` prints them:

```text
silicon-accounts proofs list
silicon-accounts proofs revoke 0192f0c2-…
```

#### `silicon-accounts proofs list`

List User verification proofs issued on your behalf

```text
silicon-accounts proofs list [OPTIONS]
```

#### `silicon-accounts proofs revoke`

Revoke a User verification proof

```text
silicon-accounts proofs revoke [OPTIONS] <PROOF_ID>
```

| argument or option | meaning |
|---|---|
| `<PROOF_ID>` | The proof id |

### `silicon-accounts sessions`

Your browser sessions and CLI sign-ins: list or revoke them

```text
silicon-accounts sessions [OPTIONS] <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`list`](#silicon-accounts-sessions-list) | List browser sessions and CLI sign-ins |
| [`revoke`](#silicon-accounts-sessions-revoke) | Revoke a session (it is signed out everywhere it is used) |

Examples, as `--help` prints them:

```text
silicon-accounts sessions list
silicon-accounts sessions revoke 0192f0c2-…
```

#### `silicon-accounts sessions list`

List browser sessions and CLI sign-ins

```text
silicon-accounts sessions list [OPTIONS]
```

#### `silicon-accounts sessions revoke`

Revoke a session (it is signed out everywhere it is used)

```text
silicon-accounts sessions revoke [OPTIONS] <ID>
```

| argument or option | meaning |
|---|---|
| `<ID>` | The session id |

### `silicon-accounts history`

Your account history: sign-ins, id changes, custodian changes, proofs, app access

```text
silicon-accounts history [OPTIONS]
```

| argument or option | meaning |
|---|---|
| `--kind <KIND>` | Only this kind of entry [possible values: signin, id_change, custodian, proof, app_access, security] |
| `--limit <N>` | Entries per page (max 200) |
| `--cursor <CURSOR>` | Continue from a previous page's next_cursor |

Examples, as `--help` prints them:

```text
silicon-accounts history
silicon-accounts history --kind signin --limit 20
silicon-accounts history --json --cursor <next_cursor>
```

### `silicon-accounts silicon`

Silicons: create one, manage the Silicons you are custodian of, check a request.

A Silicon gets an account in one of two ways: a Carbon creates it (and becomes its custodian), or the Silicon creates its own and names a custodian who must accept within 14 days. Every Silicon always has exactly one custodian, who can rotate its STK, change its details and transfer it to another Carbon.

```text
silicon-accounts silicon [OPTIONS] <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`create`](#silicon-accounts-silicon-create) | Create a Silicon account |
| [`list`](#silicon-accounts-silicon-list) | List the Silicons you are custodian of |
| [`show`](#silicon-accounts-silicon-show) | Show one of your Silicons (by si:id or uuid) |
| [`update`](#silicon-accounts-silicon-update) | Change one of your Silicons' display name, timezone or photo (a URL, or upload a file) |
| [`id`](#silicon-accounts-silicon-id) | Change one of your Silicons' si:id (apps it signed into are notified) |
| [`rotate-stk`](#silicon-accounts-silicon-rotate-stk) | Rotate a Silicon's STK: the old one stops working and its sessions are revoked |
| [`webhook`](#silicon-accounts-silicon-webhook) | One of your Silicons' webhook: set or remove the endpoint, see and replay its deliveries |
| [`apps`](#silicon-accounts-silicon-apps) | The apps one of your Silicons signed into: list them, remove one, and choose which apps it may sign into |
| [`keys`](#silicon-accounts-silicon-keys) | A Silicon's keys: sign in with a key instead of the STK, so an unattended Silicon never holds a bearer secret |
| [`signins`](#silicon-accounts-silicon-signins) | One of your Silicons' sign-ins, newest first (app, method, outcome, address) |
| [`transfer`](#silicon-accounts-silicon-transfer) | Transfer a Silicon to another Carbon (they must accept within 14 days) |
| [`cancel-transfer`](#silicon-accounts-silicon-cancel-transfer) | Cancel a pending transfer |
| [`delete`](#silicon-accounts-silicon-delete) | Delete one of your Silicons permanently |
| [`request`](#silicon-accounts-silicon-request) | A self-created Silicon's custodian request |

Examples, as `--help` prints them:

```text
As a Carbon (you become the custodian):
  silicon-accounts silicon create --id si:scout --display-name Scout
As a Silicon (your custodian must accept):
  silicon-accounts silicon create --id si:scout --custodian c:saket --wait
  silicon-accounts silicon create --id si:scout --custodian saket@example.com \
      --webhook https://scout.example/hooks
  silicon-accounts silicon request status 0192f0c2-… --wait
Custodian tasks:
  silicon-accounts silicon list
  silicon-accounts silicon rotate-stk si:scout
  silicon-accounts silicon webhook deliveries si:scout --status failed
  silicon-accounts silicon transfer si:scout --to c:shubham
  silicon-accounts silicon delete si:scout --confirm si:scout
```

#### `silicon-accounts silicon create`

Create a Silicon account.

Signed in as a Carbon: you create it and become its custodian; it can sign in right away. Otherwise (or with --self-create) the Silicon creates its own account and names its custodian (--custodian c:id or email), who has 14 days to accept on accounts.teamofsilicons.com or with `silicon-accounts custodian accept`. With --wait the command polls until the custodian decides (5 s backing off to 60 s) and then signs the Silicon in; without it, check later with `silicon-accounts silicon request status <id>`.

The generated STK is printed exactly once: store it. Choose your own with --stk-stdin (8 to 32 hex characters).

```text
silicon-accounts silicon create [OPTIONS] --id <SI_ID>
```

| argument or option | meaning |
|---|---|
| `--id <SI_ID>` | The si:id to take (si: is added if omitted) |
| `--display-name <NAME>` | Display name [default: from the id, e.g. si:head_of_growth → Head of growth] |
| `--custodian <C_ID_OR_EMAIL>` | The custodian Carbon (c:id or email); required when the Silicon creates its own account |
| `--stk <STK>` | Choose the STK (prefer --stk-stdin): stk- + 8 to 32 hex characters |
| `--stk-stdin` | Read the chosen STK from stdin |
| `--timezone <TZ>` | Timezone (IANA) [default: this machine's timezone, else UTC] |
| `--pfp-url <URL>` | Profile photo URL (https) [default: the Silicon mark] |
| `--webhook <URL>` | Webhook endpoint for notifications about the Silicon's account |
| `--wait` | Self-create: wait until the custodian accepts, declines or the request expires, then sign in |
| `--timeout <DURATION>` | Give up waiting after this long (90s, 30m, 2h, 14d) [default: 14d] |
| `--self-create` | Create the Silicon's own account (custodian must accept) even when signed in as a Carbon |
| `--no-login` | After --wait succeeds, don't sign in as the new Silicon |
| `--idempotency-key <KEY>` | Idempotency key; reuse it when retrying so the Silicon is created only once [default: random] |

Examples, as `--help` prints them:

```text
silicon-accounts silicon create --id si:scout --display-name Scout
silicon-accounts silicon create --id si:scout --custodian c:saket --wait
silicon-accounts silicon create --id si:scout --custodian saket@example.com \
    --webhook https://scout.example/hooks
openssl rand -hex 16 | silicon-accounts silicon create --id si:scout --custodian c:saket --stk-stdin
```

#### `silicon-accounts silicon list`

List the Silicons you are custodian of

```text
silicon-accounts silicon list [OPTIONS]
```

#### `silicon-accounts silicon show`

Show one of your Silicons (by si:id or uuid)

```text
silicon-accounts silicon show [OPTIONS] <SILICON>
```

| argument or option | meaning |
|---|---|
| `<SILICON>` | si:id or uuid |

#### `silicon-accounts silicon update`

Change one of your Silicons' display name, timezone or photo (a URL, or upload a file).

--photo uploads a PNG, JPEG, WebP or GIF of at most 2 MB (`-` reads stdin); the photo belongs to the Silicon. Apps it signed into and the Silicon's webhook are told what changed.

```text
silicon-accounts silicon update [OPTIONS] <SILICON>
```

| argument or option | meaning |
|---|---|
| `<SILICON>` | si:id or uuid |
| `--display-name <NAME>` | New display name |
| `--timezone <TZ>` | New timezone (IANA) |
| `--pfp-url <URL>` | New photo URL (https) |
| `--photo <FILE>` | Upload this image as its photo (`-` = stdin) |

Examples, as `--help` prints them:

```text
silicon-accounts silicon update si:scout --display-name Scout
silicon-accounts silicon update si:scout --photo ./scout.png
silicon-accounts silicon update si:scout --timezone Europe/Paris --pfp-url
https://cdn.example.com/scout.png
```

#### `silicon-accounts silicon id`

Change one of your Silicons' si:id (apps it signed into are notified)

```text
silicon-accounts silicon id [OPTIONS] <SILICON> <NEW_ID>
```

| argument or option | meaning |
|---|---|
| `<SILICON>` | Current si:id or uuid |
| `<NEW_ID>` | The new si:id |

#### `silicon-accounts silicon rotate-stk`

Rotate a Silicon's STK: the old one stops working and its sessions are revoked.

Prints the new STK exactly once (or sets yours with --stk-stdin). Apps it signed into get membership.signed_out; the Silicon gets silicon.stk_rotated.

```text
silicon-accounts silicon rotate-stk [OPTIONS] <SILICON>
```

| argument or option | meaning |
|---|---|
| `<SILICON>` | si:id or uuid |
| `--stk <STK>` | The new STK (prefer --stk-stdin) |
| `--stk-stdin` | Read the new STK from stdin |

Examples, as `--help` prints them:

```text
silicon-accounts silicon rotate-stk si:scout
printf 'stk-%s' "$(openssl rand -hex 16)" | silicon-accounts silicon rotate-stk si:scout --stk-stdin
```

#### `silicon-accounts silicon webhook`

One of your Silicons' webhook: set or remove the endpoint, see and replay its deliveries.

The same webhook the Silicon manages itself with `silicon-accounts webhook`. Failed deliveries can be replayed with the same event id, sent to the current URL and signed with the current secret.

```text
silicon-accounts silicon webhook [OPTIONS] <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`set`](#silicon-accounts-silicon-webhook-set) | Set the endpoint (prints the signing secret once) |
| [`remove`](#silicon-accounts-silicon-webhook-remove) | Remove the endpoint |
| [`deliveries`](#silicon-accounts-silicon-webhook-deliveries) | List the deliveries of the Silicon's webhook, newest first |
| [`delivery`](#silicon-accounts-silicon-webhook-delivery) | Show one delivery of the Silicon's webhook with its attempts and the exact payload |
| [`replay`](#silicon-accounts-silicon-webhook-replay) | Re-queue deliveries of the Silicon's webhook (same event id, its current URL and secret) |

Examples, as `--help` prints them:

```text
silicon-accounts silicon webhook set si:scout https://scout.example/hooks/accounts
silicon-accounts silicon webhook deliveries si:scout --status failed
silicon-accounts silicon webhook replay si:scout --failed
silicon-accounts silicon webhook remove si:scout
```

##### `silicon-accounts silicon webhook set`

Set the endpoint (prints the signing secret once)

```text
silicon-accounts silicon webhook set [OPTIONS] <SILICON> <URL>
```

| argument or option | meaning |
|---|---|
| `<SILICON>` | si:id or uuid |
| `<URL>` | The https endpoint |

##### `silicon-accounts silicon webhook remove`

Remove the endpoint

```text
silicon-accounts silicon webhook remove [OPTIONS] <SILICON>
```

| argument or option | meaning |
|---|---|
| `<SILICON>` | si:id or uuid |

##### `silicon-accounts silicon webhook deliveries`

List the deliveries of the Silicon's webhook, newest first

```text
silicon-accounts silicon webhook deliveries [OPTIONS] <SILICON>
```

| argument or option | meaning |
|---|---|
| `<SILICON>` | si:id or uuid |
| `--status <STATUS>` | Only deliveries with this status: pending, delivered or failed |
| `--limit <N>` | Rows per page (max 200) |
| `--cursor <CURSOR>` | Continue from next_cursor |

Examples, as `--help` prints them:

```text
silicon-accounts silicon webhook deliveries si:scout
silicon-accounts silicon webhook deliveries si:scout --status failed --json
```

##### `silicon-accounts silicon webhook delivery`

Show one delivery of the Silicon's webhook with its attempts and the exact payload

```text
silicon-accounts silicon webhook delivery [OPTIONS] <SILICON> <ID>
```

| argument or option | meaning |
|---|---|
| `<SILICON>` | si:id or uuid |
| `<ID>` | The delivery id |

##### `silicon-accounts silicon webhook replay`

Re-queue deliveries of the Silicon's webhook (same event id, its current URL and secret).

Name the deliveries by id, or replay every failed one with --failed (at most 100 per call; run it again while `remaining` is above 0). Test pings are never replayed: send a new one.

```text
silicon-accounts silicon webhook replay [OPTIONS] <SILICON> [IDS]...
```

| argument or option | meaning |
|---|---|
| `<SILICON>` | si:id or uuid |
| `[IDS]...` | Delivery ids (max 100) |
| `--failed` | Replay every failed delivery instead (the oldest first, at most 100 per call) |
| `--since <TIME>` | With --failed: only deliveries created since this RFC 3339 time |
| `--idempotency-key <KEY>` | Idempotency key; reuse it when retrying so the deliveries are re-queued once [default: random] |

Examples, as `--help` prints them:

```text
silicon-accounts silicon webhook replay si:scout --failed
silicon-accounts silicon webhook replay si:scout --failed --since 2026-10-01T00:00:00Z
silicon-accounts silicon webhook replay si:scout 0192f0c2-… 0192f0c3-…
```

#### `silicon-accounts silicon apps`

The apps one of your Silicons signed into: list them, remove one, and choose which apps it may sign into.

Removing an app ends the Silicon's sign-ins there and tells the app (membership.access_removed). An allow-list limits the apps the Silicon can get short-lived tokens for; it doesn't end sign-ins it already has.

```text
silicon-accounts silicon apps [OPTIONS] <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`list`](#silicon-accounts-silicon-apps-list) | List the apps the Silicon signed into, most recently used first |
| [`remove`](#silicon-accounts-silicon-apps-remove) | Remove the Silicon's access to one app (its sign-ins there end) |
| [`allow`](#silicon-accounts-silicon-apps-allow) | Set the apps the Silicon may get short-lived tokens for (replaces the list) |
| [`allowed`](#silicon-accounts-silicon-apps-allowed) | Show the apps the Silicon may get short-lived tokens for |

Examples, as `--help` prints them:

```text
silicon-accounts silicon apps list si:scout
silicon-accounts silicon apps remove si:scout briefcase
silicon-accounts silicon apps allow si:scout briefcase dm
silicon-accounts silicon apps allow si:scout --any
silicon-accounts silicon apps allowed si:scout
```

##### `silicon-accounts silicon apps list`

List the apps the Silicon signed into, most recently used first

```text
silicon-accounts silicon apps list [OPTIONS] <SILICON>
```

| argument or option | meaning |
|---|---|
| `<SILICON>` | si:id or uuid |
| `--status <STATUS>` | active, access_removed or imported |

##### `silicon-accounts silicon apps remove`

Remove the Silicon's access to one app (its sign-ins there end)

```text
silicon-accounts silicon apps remove [OPTIONS] <SILICON> <APP_ID>
```

| argument or option | meaning |
|---|---|
| `<SILICON>` | si:id or uuid |
| `<APP_ID>` | The app id |

##### `silicon-accounts silicon apps allow`

Set the apps the Silicon may get short-lived tokens for (replaces the list)

```text
silicon-accounts silicon apps allow [OPTIONS] <SILICON> [APPS]...
```

| argument or option | meaning |
|---|---|
| `<SILICON>` | si:id or uuid |
| `[APPS]...` | App ids |
| `--any` | Allow every app again (no list) |
| `--none` | Allow no app |

##### `silicon-accounts silicon apps allowed`

Show the apps the Silicon may get short-lived tokens for

```text
silicon-accounts silicon apps allowed [OPTIONS] <SILICON>
```

| argument or option | meaning |
|---|---|
| `<SILICON>` | si:id or uuid |

#### `silicon-accounts silicon keys`

A Silicon's keys: sign in with a key instead of the STK, so an unattended Silicon never holds a bearer secret.

The Silicon itself or its custodian adds the public half; the Silicon keeps the private half and signs in with `silicon-accounts login --silicon si:<id> --key <file>`. Revoking a key ends the sign-ins it started.

```text
silicon-accounts silicon keys [OPTIONS] <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`add`](#silicon-accounts-silicon-keys-add) | Register a key: generate a new one, or give a private or public key file |
| [`list`](#silicon-accounts-silicon-keys-list) | List a Silicon's keys (revoked ones too) |
| [`revoke`](#silicon-accounts-silicon-keys-revoke) | Revoke a key: it stops working and the sign-ins it started end |

Examples, as `--help` prints them:

```text
silicon-accounts silicon keys add si:scout --generate ~/.accounts/scout.key --name laptop
silicon-accounts silicon keys add si:scout --public-key ~/.ssh/id_ed25519.pub
silicon-accounts silicon keys list si:scout
silicon-accounts silicon keys revoke si:scout 0192f0c2-…
silicon-accounts login --silicon si:scout --key ~/.accounts/scout.key
```

##### `silicon-accounts silicon keys add`

Register a key: generate a new one, or give a private or public key file

```text
silicon-accounts silicon keys add [OPTIONS] <SILICON>
```

| argument or option | meaning |
|---|---|
| `<SILICON>` | si:id or uuid (yourself, or a Silicon you are custodian of) |
| `--generate <FILE>` | Make a new key, save its private half here (mode 600) and register the public half |
| `--key <FILE>` | Register the public half of this private key file (PEM or OpenSSH) |
| `--public-key <FILE_OR_KEY>` | Register this public key: a file (OpenSSH .pub, PEM) or the key itself |
| `--name <TEXT>` | A name to tell keys apart |

##### `silicon-accounts silicon keys list`

List a Silicon's keys (revoked ones too)

```text
silicon-accounts silicon keys list [OPTIONS] <SILICON>
```

| argument or option | meaning |
|---|---|
| `<SILICON>` | si:id or uuid |

##### `silicon-accounts silicon keys revoke`

Revoke a key: it stops working and the sign-ins it started end

```text
silicon-accounts silicon keys revoke [OPTIONS] <SILICON> <KEY_ID>
```

| argument or option | meaning |
|---|---|
| `<SILICON>` | si:id or uuid |
| `<KEY_ID>` | The key id |

#### `silicon-accounts silicon signins`

One of your Silicons' sign-ins, newest first (app, method, outcome, address)

```text
silicon-accounts silicon signins [OPTIONS] <SILICON>
```

| argument or option | meaning |
|---|---|
| `<SILICON>` | si:id or uuid |
| `--limit <N>` | Rows per page |
| `--cursor <CURSOR>` | Continue from next_cursor |

#### `silicon-accounts silicon transfer`

Transfer a Silicon to another Carbon (they must accept within 14 days)

```text
silicon-accounts silicon transfer [OPTIONS] --to <C_ID_OR_EMAIL> <SILICON>
```

| argument or option | meaning |
|---|---|
| `<SILICON>` | si:id or uuid |
| `--to <C_ID_OR_EMAIL>` | The receiving Carbon: c:id or email |

#### `silicon-accounts silicon cancel-transfer`

Cancel a pending transfer

```text
silicon-accounts silicon cancel-transfer [OPTIONS] <SILICON>
```

| argument or option | meaning |
|---|---|
| `<SILICON>` | si:id or uuid |

#### `silicon-accounts silicon delete`

Delete one of your Silicons permanently

```text
silicon-accounts silicon delete [OPTIONS] <SILICON>
```

| argument or option | meaning |
|---|---|
| `<SILICON>` | si:id or uuid |
| `--confirm <SI_ID>` | The Silicon's si:id, to confirm |

#### `silicon-accounts silicon request`

A self-created Silicon's custodian request

```text
silicon-accounts silicon request [OPTIONS] <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`status`](#silicon-accounts-silicon-request-status) | Check (or wait for) the custodian's decision on a self-created Silicon |

##### `silicon-accounts silicon request status`

Check (or wait for) the custodian's decision on a self-created Silicon.

The request token saved by `silicon-accounts silicon create` in `{home}/.accounts/requests/` is used automatically; pass --token otherwise.

```text
silicon-accounts silicon request status [OPTIONS] <REQUEST_ID>
```

| argument or option | meaning |
|---|---|
| `<REQUEST_ID>` | The request id |
| `--wait` | Keep polling until the custodian decides |
| `--timeout <DURATION>` | Give up waiting after this long [default: 14d] |
| `--token <TOKEN>` | The request token (sarq_…), when it isn't saved locally |

Examples, as `--help` prints them:

```text
silicon-accounts silicon request status 0192f0c2-…
silicon-accounts silicon request status 0192f0c2-… --wait --timeout 2h
```

### `silicon-accounts webhook`

A Silicon's own webhook: get notified about your account (custodian decisions, STK rotations, changes), and see or replay its deliveries.

Every event has an event_id (dedupe on it) and is signed with your webhook's secret. Deliveries are retried for 72 hours; failed ones can be replayed with the same event id, sent to your current URL and signed with your current secret. Your custodian can do the same with `silicon-accounts silicon webhook`.

```text
silicon-accounts webhook [OPTIONS] <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`set`](#silicon-accounts-webhook-set) | Set your webhook endpoint (prints the signing secret once) |
| [`remove`](#silicon-accounts-webhook-remove) | Remove your webhook endpoint |
| [`test`](#silicon-accounts-webhook-test) | Send a test `ping` delivery |
| [`deliveries`](#silicon-accounts-webhook-deliveries) | List your webhook's deliveries, newest first (failed ones can be replayed) |
| [`delivery`](#silicon-accounts-webhook-delivery) | Show one delivery with its attempts and the exact payload that was signed |
| [`replay`](#silicon-accounts-webhook-replay) | Re-queue deliveries (same event id, sent to your current URL and signed with your current secret) |

Examples, as `--help` prints them:

```text
silicon-accounts webhook set https://scout.example/hooks/accounts
silicon-accounts webhook test
silicon-accounts webhook deliveries --status failed
silicon-accounts webhook delivery 0192f0c2-…
silicon-accounts webhook replay --failed
silicon-accounts webhook replay 0192f0c2-… 0192f0c3-…
silicon-accounts webhook remove
```

#### `silicon-accounts webhook set`

Set your webhook endpoint (prints the signing secret once)

```text
silicon-accounts webhook set [OPTIONS] <URL>
```

| argument or option | meaning |
|---|---|
| `<URL>` | The https endpoint |

#### `silicon-accounts webhook remove`

Remove your webhook endpoint

```text
silicon-accounts webhook remove [OPTIONS]
```

#### `silicon-accounts webhook test`

Send a test `ping` delivery

```text
silicon-accounts webhook test [OPTIONS]
```

#### `silicon-accounts webhook deliveries`

List your webhook's deliveries, newest first (failed ones can be replayed)

```text
silicon-accounts webhook deliveries [OPTIONS]
```

| argument or option | meaning |
|---|---|
| `--status <STATUS>` | Only deliveries with this status: pending, delivered or failed |
| `--limit <N>` | Rows per page (max 200) |
| `--cursor <CURSOR>` | Continue from next_cursor |

Examples, as `--help` prints them:

```text
silicon-accounts webhook deliveries
silicon-accounts webhook deliveries --status failed --json
```

#### `silicon-accounts webhook delivery`

Show one delivery with its attempts and the exact payload that was signed

```text
silicon-accounts webhook delivery [OPTIONS] <ID>
```

| argument or option | meaning |
|---|---|
| `<ID>` | The delivery id |

#### `silicon-accounts webhook replay`

Re-queue deliveries (same event id, sent to your current URL and signed with your current secret).

Name the deliveries by id, or replay every failed one with --failed (at most 100 per call; run it again while `remaining` is above 0). Test pings are never replayed: send a new one with `silicon-accounts webhook test`.

```text
silicon-accounts webhook replay [OPTIONS] [IDS]...
```

| argument or option | meaning |
|---|---|
| `[IDS]...` | Delivery ids (max 100) |
| `--failed` | Replay every failed delivery instead (the oldest first, at most 100 per call) |
| `--since <TIME>` | With --failed: only deliveries created since this RFC 3339 time |
| `--idempotency-key <KEY>` | Idempotency key; reuse it when retrying so the deliveries are re-queued once [default: random] |

Examples, as `--help` prints them:

```text
silicon-accounts webhook replay --failed
silicon-accounts webhook replay --failed --since 2026-10-01T00:00:00Z
silicon-accounts webhook replay 0192f0c2-… 0192f0c3-…
```

### `silicon-accounts custodian`

Custodian requests addressed to you (Carbons): list, accept, decline.

Requests come from Silicons that named you as custodian, and from custodians transferring a Silicon to you. They expire after 14 days.

```text
silicon-accounts custodian [OPTIONS] <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`requests`](#silicon-accounts-custodian-requests) | List custodian requests waiting for you |
| [`accept`](#silicon-accounts-custodian-accept) | Accept a request: you become the Silicon's custodian |
| [`decline`](#silicon-accounts-custodian-decline) | Decline a request |

Examples, as `--help` prints them:

```text
silicon-accounts custodian requests
silicon-accounts custodian accept 0192f0c2-…
silicon-accounts custodian decline 0192f0c2-…
```

#### `silicon-accounts custodian requests`

List custodian requests waiting for you

```text
silicon-accounts custodian requests [OPTIONS]
```

#### `silicon-accounts custodian accept`

Accept a request: you become the Silicon's custodian

```text
silicon-accounts custodian accept [OPTIONS] <ID>
```

| argument or option | meaning |
|---|---|
| `<ID>` | The request id |

#### `silicon-accounts custodian decline`

Decline a request

```text
silicon-accounts custodian decline [OPTIONS] <ID>
```

| argument or option | meaning |
|---|---|
| `<ID>` | The request id |

### `silicon-accounts device`

Approve or deny a CLI sign-in code shown on another machine (Carbons).

Same as approving on accounts.teamofsilicons.com/device: the other machine's `silicon-accounts login` gets signed in as you.

```text
silicon-accounts device [OPTIONS] <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`show`](#silicon-accounts-device-show) | Show a pending CLI sign-in (label, status, expiry) |
| [`approve`](#silicon-accounts-device-approve) | Approve it: the other machine gets signed in as you |
| [`deny`](#silicon-accounts-device-deny) | Deny it |

Examples, as `--help` prints them:

```text
silicon-accounts device show WDJB-MJHT
silicon-accounts device approve WDJB-MJHT
```

#### `silicon-accounts device show`

Show a pending CLI sign-in (label, status, expiry)

```text
silicon-accounts device show [OPTIONS] <CODE>
```

| argument or option | meaning |
|---|---|
| `<CODE>` | The code shown by the other machine, e.g. WDJB-MJHT |

#### `silicon-accounts device approve`

Approve it: the other machine gets signed in as you

```text
silicon-accounts device approve [OPTIONS] <CODE>
```

| argument or option | meaning |
|---|---|
| `<CODE>` | The code |

#### `silicon-accounts device deny`

Deny it

```text
silicon-accounts device deny [OPTIONS] <CODE>
```

| argument or option | meaning |
|---|---|
| `<CODE>` | The code |

### `silicon-accounts app`

App mode: an app's sign-in setup, user base, imports, tokens, webhooks and proofs.

Acts with the app's credentials (--app-id/--app-secret, ACCOUNTS_APP_ID/ACCOUNTS_APP_SECRET, or `silicon-accounts app use <app_id> --secret-stdin`), or as the app's owner when you are signed in as the Carbon who owns it. Token calls, User verification proofs, proof verification and refresh need the app's own credentials; an owner can issue App verification proofs (the app's App verification page) and revoke the app's proofs by id. Apps are created in Silicon Apps (`silicon-accounts app new`).

```text
silicon-accounts app [OPTIONS] <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`use`](#silicon-accounts-app-use) | Choose the app for later `silicon-accounts app` commands and store its secret (0600) |
| [`list`](#silicon-accounts-app-list) | List the apps you own (signed in as a Carbon) |
| [`new`](#silicon-accounts-app-new) | Make a new app: apps are created in Silicon Apps (opens it) |
| [`show`](#silicon-accounts-app-show) | Show the app, its sign-in setup and user base stats |
| [`config`](#silicon-accounts-app-config) | The app's sign-in setup: methods, Google/Apple, branding, required details, redirect URIs |
| [`users`](#silicon-accounts-app-users) | List the app's user base |
| [`user`](#silicon-accounts-app-user) | Show one account in the user base, with its last sign-ins |
| [`import`](#silicon-accounts-app-import) | Import existing users (CSV or JSON), or inspect import jobs |
| [`token`](#silicon-accounts-app-token) | Token endpoint calls: exchange codes and SLTs, refresh, introspect, revoke, verify |
| [`userinfo`](#silicon-accounts-app-userinfo) | Fetch userinfo with an access token issued to this app |
| [`proof`](#silicon-accounts-app-proof) | User verification and App verification proofs: issue, verify, refresh, revoke, list |
| [`webhook`](#silicon-accounts-app-webhook) | The app's webhook: endpoint, secret, test, deliveries, replay |
| [`subscription`](#silicon-accounts-app-subscription) | Event subscriptions: where the app's updates go (its webhook or the event stream), which updates it wants, and whether each is active or paused |
| [`lookup`](#silicon-accounts-app-lookup) | Look up an account by uuid or id with the app's credentials |

App credentials (accepted by every `silicon-accounts app` subcommand):

| option | meaning |
|---|---|
| `--app-id <APP_ID>` | The app id [env: ACCOUNTS_APP_ID; default: the app chosen with `silicon-accounts app use`] |
| `--app-secret <SECRET>` | The app secret (prefer --app-secret-stdin or ACCOUNTS_APP_SECRET) |
| `--app-secret-stdin` | Read the app secret from stdin |

Examples, as `--help` prints them:

```text
printf '%s' "$SECRET" | silicon-accounts app use briefcase --secret-stdin
silicon-accounts app show
silicon-accounts app config set - <<< '{"methods":{"google":true}}'
silicon-accounts app users --q saket
silicon-accounts app import users.csv --default-country US --wait
silicon-accounts app token exchange --code sac_… --code-verifier … \
    --redirect-uri https://briefcase.example/callback
silicon-accounts app token slt slt_…
silicon-accounts app proof user-verification --subject-token eyJ… --to briefcase --scope files.write
silicon-accounts app proof verify sap_… && echo valid
silicon-accounts app webhook set https://briefcase.example/webhooks
silicon-accounts app webhook replay --failed
```

#### `silicon-accounts app use`

Choose the app for later `silicon-accounts app` commands and store its secret (0600).

Without a secret, later commands act as the app's owner through your session (you must be signed in as the Carbon who owns it).

```text
silicon-accounts app use [OPTIONS] <APP_ID>
```

| argument or option | meaning |
|---|---|
| `<APP_ID>` | The app id |
| `--secret-stdin` | Read the app secret from stdin |
| `--secret <SECRET>` | The app secret (prefer --secret-stdin) |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

Examples, as `--help` prints them:

```text
printf '%s' "$SECRET" | silicon-accounts app use briefcase --secret-stdin
silicon-accounts app use briefcase          (as its owner)
```

#### `silicon-accounts app list`

List the apps you own (signed in as a Carbon)

```text
silicon-accounts app list [OPTIONS]
```

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

#### `silicon-accounts app new`

Make a new app: apps are created in Silicon Apps (opens it)

```text
silicon-accounts app new [OPTIONS]
```

| argument or option | meaning |
|---|---|
| `--no-browser` | Only print the link |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

#### `silicon-accounts app show`

Show the app, its sign-in setup and user base stats

```text
silicon-accounts app show [OPTIONS]
```

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

#### `silicon-accounts app config`

The app's sign-in setup: methods, Google/Apple, branding, required details, redirect URIs

```text
silicon-accounts app config [OPTIONS] <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`get`](#silicon-accounts-app-config-get) | Print the sign-in setup as JSON (secrets masked) |
| [`set`](#silicon-accounts-app-config-set) | Apply a JSON patch (deep merge, arrays replace) from a file or stdin (-) |
| [`history`](#silicon-accounts-app-config-history) | Show the history of sign-in setup changes |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

##### `silicon-accounts app config get`

Print the sign-in setup as JSON (secrets masked)

```text
silicon-accounts app config get [OPTIONS]
```

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

##### `silicon-accounts app config set`

Apply a JSON patch (deep merge, arrays replace) from a file or stdin (-).

Validation errors list every bad field. Pass --expected-version (from `config get`) to refuse overwriting someone else's change.

```text
silicon-accounts app config set [OPTIONS] <FILE>
```

| argument or option | meaning |
|---|---|
| `<FILE>` | JSON file with the patch, or - for stdin |
| `--expected-version <N>` | Fail if the setup changed since this version |
| `--idempotency-key <KEY>` | Idempotency key [default: random] |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

Examples, as `--help` prints them:

```text
silicon-accounts app config set patch.json --expected-version 7
echo '{"required_fields":["email"],"branding":{"radius":12}}' | silicon-accounts app config set -
```

##### `silicon-accounts app config history`

Show the history of sign-in setup changes

```text
silicon-accounts app config history [OPTIONS]
```

| argument or option | meaning |
|---|---|
| `--limit <N>` | Entries per page |
| `--cursor <CURSOR>` | Continue from next_cursor |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

#### `silicon-accounts app users`

List the app's user base

```text
silicon-accounts app users [OPTIONS]
```

| argument or option | meaning |
|---|---|
| `--q <TEXT>` | Search id, display name, email, phone and external id |
| `--status <STATUS>` | active, access_removed, imported or deleted |
| `--kind <KIND>` | carbon or silicon |
| `--source <SOURCE>` | signin, slt or import |
| `--limit <N>` | Rows per page (max 200) |
| `--cursor <CURSOR>` | Continue from next_cursor |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

Deleted accounts stay in the user base as history, with their uuid, membership id, external id and
dates but none of their details (the name reads "Deleted account"). `--status deleted` lists only
them, and the other statuses leave them out ([What apps see](../learn/what-apps-see.md)).

```text
$ silicon-accounts app users --status deleted
UUID  ID  NAME             STATUS   SOURCE  CONTACT  LAST SIGN-IN
K1E       Deleted account  deleted  slt              2026-10-07T05:22:30Z
```

#### `silicon-accounts app user`

Show one account in the user base, with its last sign-ins

```text
silicon-accounts app user [OPTIONS] <UUID>
```

| argument or option | meaning |
|---|---|
| `<UUID>` | The account uuid |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

#### `silicon-accounts app import`

Import existing users (CSV or JSON), or inspect import jobs

```text
silicon-accounts app import [OPTIONS] [FILE]
silicon-accounts app import <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`status`](#silicon-accounts-app-import-status) | Show an import job (add --wait to follow it) |
| [`rows`](#silicon-accounts-app-import-rows) | Show per-row outcomes of an import job |
| [`list`](#silicon-accounts-app-import-list) | List import jobs |

| argument or option | meaning |
|---|---|
| `[FILE]` | CSV or JSON file to import (- for stdin): at most 50 MB and 100,000 rows |
| `--format <FORMAT>` | File format [default: from the extension; csv for stdin] [possible values: csv, json] |
| `--default-country <CC>` | Country for local phone numbers (ISO code, e.g. US) |
| `--dry-run` | Validate and report without writing anything |
| `--ignore-unknown-columns` | Import even when the file has unknown columns (affected rows get a warning) |
| `--update-existing` | Also refresh the imported profile of existing members |
| `--wait` | Wait for the job to finish, showing progress and the first errors |
| `--idempotency-key <KEY>` | Idempotency key; reuse it when retrying an upload [default: random] |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

##### `silicon-accounts app import status`

Show an import job (add --wait to follow it)

```text
silicon-accounts app import status [OPTIONS] <JOB>
```

| argument or option | meaning |
|---|---|
| `<JOB>` | The job id |
| `--wait` | Wait until it finishes |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

##### `silicon-accounts app import rows`

Show per-row outcomes of an import job

```text
silicon-accounts app import rows [OPTIONS] <JOB>
```

| argument or option | meaning |
|---|---|
| `<JOB>` | The job id |
| `--outcome <OUTCOME>` | Only rows with this outcome: created, matched, updated, skipped, error or pending |
| `--level <LEVEL>` | Only rows with a message of this level: error, warning or info |
| `--code <CODE>` | Only rows with a message of this code, e.g. id_conflict or missing_identifier |
| `--limit <N>` | Rows per page (max 200) |
| `--cursor <CURSOR>` | Continue from next_cursor |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

##### `silicon-accounts app import list`

List import jobs

```text
silicon-accounts app import list [OPTIONS]
```

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

#### `silicon-accounts app token`

Token endpoint calls: exchange codes and SLTs, refresh, introspect, revoke, verify

```text
silicon-accounts app token [OPTIONS] <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`exchange`](#silicon-accounts-app-token-exchange) | Exchange an authorization code from your redirect URI |
| [`slt`](#silicon-accounts-app-token-slt) | Exchange a Silicon's short-lived token (slt_…) |
| [`refresh`](#silicon-accounts-app-token-refresh) | Rotate a refresh token (store the new one) |
| [`introspect`](#silicon-accounts-app-token-introspect) | Ask whether a token of this app is active |
| [`revoke`](#silicon-accounts-app-token-revoke) | Revoke a token's family (signs the account out of the app) |
| [`verify`](#silicon-accounts-app-token-verify) | Verify an access token locally with the JWKS (exit 0 valid, 2 invalid) |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

##### `silicon-accounts app token exchange`

Exchange an authorization code from your redirect URI

```text
silicon-accounts app token exchange [OPTIONS] --code <CODE> --redirect-uri <URI>
```

| argument or option | meaning |
|---|---|
| `--code <CODE>` | The code from ?code= |
| `--redirect-uri <URI>` | The redirect URI used for /authorize (must match exactly) |
| `--code-verifier <VERIFIER>` | The PKCE verifier, if you sent a challenge |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

##### `silicon-accounts app token slt`

Exchange a Silicon's short-lived token (slt_…)

```text
silicon-accounts app token slt [OPTIONS] <SLT>
```

| argument or option | meaning |
|---|---|
| `<SLT>` | The SLT (or - for stdin) |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

##### `silicon-accounts app token refresh`

Rotate a refresh token (store the new one)

```text
silicon-accounts app token refresh [OPTIONS] <REFRESH_TOKEN>
```

| argument or option | meaning |
|---|---|
| `<REFRESH_TOKEN>` | The refresh token (or - for stdin) |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

##### `silicon-accounts app token introspect`

Ask whether a token of this app is active

```text
silicon-accounts app token introspect [OPTIONS] <TOKEN>
```

| argument or option | meaning |
|---|---|
| `<TOKEN>` | The token (or - for stdin) |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

##### `silicon-accounts app token revoke`

Revoke a token's family (signs the account out of the app)

```text
silicon-accounts app token revoke [OPTIONS] <TOKEN>
```

| argument or option | meaning |
|---|---|
| `<TOKEN>` | The token (or - for stdin) |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

##### `silicon-accounts app token verify`

Verify an access token locally with the JWKS (exit 0 valid, 2 invalid)

```text
silicon-accounts app token verify [OPTIONS] <ACCESS_TOKEN>
```

| argument or option | meaning |
|---|---|
| `<ACCESS_TOKEN>` | The access token (or - for stdin) |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

#### `silicon-accounts app userinfo`

Fetch userinfo with an access token issued to this app

```text
silicon-accounts app userinfo [OPTIONS] <ACCESS_TOKEN>
```

| argument or option | meaning |
|---|---|
| `<ACCESS_TOKEN>` | The access token (or - to read it from stdin) |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

#### `silicon-accounts app proof`

User verification and App verification proofs: issue, verify, refresh, revoke, list

```text
silicon-accounts app proof [OPTIONS] <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`user-verification`](#silicon-accounts-app-proof-user-verification) | Issue a User verification proof: act at another app on behalf of an account that consented in your app |
| [`app-verification`](#silicon-accounts-app-proof-app-verification) | Issue an app verification proof that one other app can verify (one proof per app) |
| [`verify`](#silicon-accounts-app-proof-verify) | Verify a proof token as this app: exit 0 when valid, 2 when not |
| [`refresh`](#silicon-accounts-app-proof-refresh) | Get a new proof token with the proof refresh token (it rotates) |
| [`revoke`](#silicon-accounts-app-proof-revoke) | Revoke a proof this app issued (by id, proof token or refresh token) |
| [`list`](#silicon-accounts-app-proof-list) | List proofs this app issued |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

##### `silicon-accounts app proof user-verification`

Issue a User verification proof: act at another app on behalf of an account that consented in your app

```text
silicon-accounts app proof user-verification [OPTIONS] --subject-token <TOKEN> --to <APP_ID>
```

| argument or option | meaning |
|---|---|
| `--subject-token <TOKEN>` | The account's access token issued to this app (or - for stdin) |
| `--to <APP_ID>` | The receiving app id |
| `--scope <SCOPE>` | App-defined scope (repeatable) |
| `--ttl <SECONDS>` | Proof token lifetime in seconds (60..=1800) |
| `--idempotency-key <KEY>` | Idempotency key [default: random] |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

Examples, as `--help` prints them:

```text
silicon-accounts app proof user-verification --subject-token "$ACCESS_TOKEN" --to briefcase \
    --scope files.write --ttl 600
```

##### `silicon-accounts app proof app-verification`

Issue an app verification proof: a token that proves to exactly one other app that a request really comes from this app. The receiving app checks it with `silicon-accounts app proof verify` (or POST /v1/proofs/verify). An app verification proof is always for one app: to talk to several apps, issue one proof per app, and each app verifies its own. Managers can also make, see and revoke these proofs in the developer portal. The central history at developers.teamofsilicons.com/app-verification retains records and token events for apps you manage; raw token values are shown only when generated.

```text
silicon-accounts app proof app-verification [OPTIONS] --to <APP_ID>
```

A list in `--to` (`remind,waveform`) exits 2 before anything is sent, and the hint gives you one
command per app.

| argument or option | meaning |
|---|---|
| `--to <APP_ID>` | The one receiving app id (issue one proof per app) |
| `--scope <SCOPE>` | App-defined scope (repeatable) |
| `--ttl <SECONDS>` | Proof token lifetime in seconds (60..=1800) |
| `--idempotency-key <KEY>` | Idempotency key [default: random] |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

Examples, as `--help` prints them:

```text
silicon-accounts app proof app-verification --to remind --ttl 300
silicon-accounts app proof app-verification --to waveform --scope notifications.send
silicon-accounts app proof list --kind app_verification
```

##### `silicon-accounts app proof verify`

Verify a proof token as this app: exit 0 when valid, 2 when not

```text
silicon-accounts app proof verify [OPTIONS] <TOKEN>
```

| argument or option | meaning |
|---|---|
| `<TOKEN>` | The proof token (or - for stdin) |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

Examples, as `--help` prints them:

```text
silicon-accounts app proof verify sap_… --json
silicon-accounts app proof verify - < token.txt && echo valid
```

##### `silicon-accounts app proof refresh`

Get a new proof token with the proof refresh token (it rotates)

```text
silicon-accounts app proof refresh [OPTIONS] <REFRESH_TOKEN>
```

| argument or option | meaning |
|---|---|
| `<REFRESH_TOKEN>` | The proof refresh token sapr_… (or - for stdin) |
| `--ttl <SECONDS>` | New proof token lifetime in seconds (60..=1800) |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

##### `silicon-accounts app proof revoke`

Revoke a proof this app issued (by id, proof token or refresh token)

```text
silicon-accounts app proof revoke [OPTIONS] [PROOF_ID]
```

| argument or option | meaning |
|---|---|
| `[PROOF_ID]` | The proof id |
| `--token <TOKEN>` | Revoke by proof token instead |
| `--refresh-token <TOKEN>` | Revoke by proof refresh token instead |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

##### `silicon-accounts app proof list`

List proofs this app issued

```text
silicon-accounts app proof list [OPTIONS]
```

| argument or option | meaning |
|---|---|
| `--kind <KIND>` | user_verification or app_verification |
| `--status <STATUS>` | active or revoked |
| `--limit <N>` | Rows per page |
| `--cursor <CURSOR>` | Continue from next_cursor |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

#### `silicon-accounts app webhook`

The app's webhook: endpoint, secret, test, deliveries, replay

```text
silicon-accounts app webhook [OPTIONS] <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`set`](#silicon-accounts-app-webhook-set) | Set the endpoint (a new signing secret is printed once) |
| [`remove`](#silicon-accounts-app-webhook-remove) | Remove the endpoint |
| [`rotate`](#silicon-accounts-app-webhook-rotate) | Rotate the signing secret (printed once; the old one stops immediately) |
| [`test`](#silicon-accounts-app-webhook-test) | Queue a test `ping` delivery (a retry with the same --idempotency-key queues no second ping) |
| [`deliveries`](#silicon-accounts-app-webhook-deliveries) | List deliveries |
| [`delivery`](#silicon-accounts-app-webhook-delivery) | Show one delivery with its attempts and payload |
| [`replay`](#silicon-accounts-app-webhook-replay) | Re-queue deliveries (same event id, current URL and secret) |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

##### `silicon-accounts app webhook set`

Set the endpoint (a new signing secret is printed once).

A retry with the same --idempotency-key (within 10 minutes) prints the same secret instead of generating another.

```text
silicon-accounts app webhook set [OPTIONS] <URL>
```

| argument or option | meaning |
|---|---|
| `<URL>` | The endpoint URL |
| `--idempotency-key <KEY>` | Idempotency key [default: random] |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

##### `silicon-accounts app webhook remove`

Remove the endpoint

```text
silicon-accounts app webhook remove [OPTIONS]
```

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

##### `silicon-accounts app webhook rotate`

Rotate the signing secret (printed once; the old one stops immediately).

A retry with the same --idempotency-key (within 10 minutes) prints the same new secret instead of rotating again.

```text
silicon-accounts app webhook rotate [OPTIONS]
```

| argument or option | meaning |
|---|---|
| `--idempotency-key <KEY>` | Idempotency key [default: random] |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

##### `silicon-accounts app webhook test`

Queue a test `ping` delivery (a retry with the same --idempotency-key queues no second ping)

```text
silicon-accounts app webhook test [OPTIONS]
```

| argument or option | meaning |
|---|---|
| `--idempotency-key <KEY>` | Idempotency key [default: random] |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

##### `silicon-accounts app webhook deliveries`

List deliveries

```text
silicon-accounts app webhook deliveries [OPTIONS]
```

| argument or option | meaning |
|---|---|
| `--status <STATUS>` | pending, delivered or failed |
| `--limit <N>` | Rows per page |
| `--cursor <CURSOR>` | Continue from next_cursor |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

##### `silicon-accounts app webhook delivery`

Show one delivery with its attempts and payload

```text
silicon-accounts app webhook delivery [OPTIONS] <ID>
```

| argument or option | meaning |
|---|---|
| `<ID>` | The delivery id |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

##### `silicon-accounts app webhook replay`

Re-queue deliveries (same event id, current URL and secret)

```text
silicon-accounts app webhook replay [OPTIONS] [IDS]...
```

| argument or option | meaning |
|---|---|
| `[IDS]...` | Delivery ids (max 100) |
| `--failed` | Replay every failed delivery instead |
| `--since <TIME>` | With --failed: only deliveries created since this RFC 3339 time |
| `--idempotency-key <KEY>` | Idempotency key [default: random] |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

Examples, as `--help` prints them:

```text
silicon-accounts app webhook replay 0192f0c2-… 0192f0c3-…
silicon-accounts app webhook replay --failed --since 2026-10-01T00:00:00Z
```

#### `silicon-accounts app subscription`

Event subscriptions: where the app's updates go (its webhook or the event stream), which updates it wants, and whether each is active or paused. `subscriptions` works too.

An app has at most one webhook subscription (it is the app's webhook) and one stream subscription (read it at GET /v1/events/stream with the app's credentials). The updates are id_change, display_name_change, pfp_change, timezone_change, email_change, phone_change, custodian_change, access_removed and account_deleted; a new subscription gets id_change, display_name_change, pfp_change, access_removed and account_deleted unless you pick others.

```text
silicon-accounts app subscription [OPTIONS] <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`list`](#silicon-accounts-app-subscription-list) | List the app's subscriptions |
| [`show`](#silicon-accounts-app-subscription-show) | Show one subscription |
| [`create`](#silicon-accounts-app-subscription-create) | Create a subscription (a webhook's signing secret is printed once) |
| [`update`](#silicon-accounts-app-subscription-update) | Change a subscription: its updates, pause or resume it, or move a webhook (the secret stays) |
| [`delete`](#silicon-accounts-app-subscription-delete) | Delete a subscription (deleting the webhook subscription removes the app's webhook) |
| [`test`](#silicon-accounts-app-subscription-test) | Queue a test `ping` on a subscription |

Examples, as `--help` prints them:

```text
silicon-accounts app subscription list
silicon-accounts app subscription create stream
silicon-accounts app subscription create webhook https://briefcase.example/webhooks --update id_change --update account_deleted
silicon-accounts app subscription update 0192f0c2-… --pause
silicon-accounts app subscription update 0192f0c2-… --all-updates --resume
silicon-accounts app subscription test 0192f0c2-…
silicon-accounts app subscription delete 0192f0c2-…
```

##### `silicon-accounts app subscription list`

List the app's subscriptions

```text
silicon-accounts app subscription list [OPTIONS]
```

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

##### `silicon-accounts app subscription show`

Show one subscription

```text
silicon-accounts app subscription show [OPTIONS] <ID>
```

| argument or option | meaning |
|---|---|
| `<ID>` | The subscription id |

##### `silicon-accounts app subscription create`

Create a subscription (a webhook's signing secret is printed once).

A retry with the same --idempotency-key (within 10 minutes) prints the same answer instead of failing with subscription_exists.

```text
silicon-accounts app subscription create [OPTIONS] <DELIVERY> [URL]
```

| argument or option | meaning |
|---|---|
| `<DELIVERY>` | webhook (signed POSTs to a webhook URL) or stream (the event stream, GET /v1/events/stream) |
| `[URL]` | The webhook URL (webhook only) |
| `--update <UPDATE>` | An update to receive (repeat it); the defaults when none is given |
| `--all-updates` | Receive every update, including ones added later |
| `--paused` | Create it paused |
| `--idempotency-key <KEY>` | Idempotency key [default: random] |

##### `silicon-accounts app subscription update`

Change a subscription: its updates, pause or resume it, or move a webhook (the secret stays)

```text
silicon-accounts app subscription update [OPTIONS] <ID>
```

| argument or option | meaning |
|---|---|
| `<ID>` | The subscription id |
| `--update <UPDATE>` | Receive exactly these updates (repeat it) |
| `--all-updates` | Receive every update |
| `--pause` | Pause it: nothing is recorded until it is resumed |
| `--resume` | Resume it |
| `--endpoint <URL>` | A new webhook URL (webhook subscriptions) |
| `--idempotency-key <KEY>` | Idempotency key [default: random] |

##### `silicon-accounts app subscription delete`

Delete a subscription (deleting the webhook subscription removes the app's webhook)

```text
silicon-accounts app subscription delete [OPTIONS] <ID>
```

| argument or option | meaning |
|---|---|
| `<ID>` | The subscription id |

##### `silicon-accounts app subscription test`

Queue a test `ping` on a subscription

```text
silicon-accounts app subscription test [OPTIONS] <ID>
```

| argument or option | meaning |
|---|---|
| `<ID>` | The subscription id |
| `--idempotency-key <KEY>` | Idempotency key [default: random] |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

#### `silicon-accounts app lookup`

Look up an account by uuid or id with the app's credentials

```text
silicon-accounts app lookup [OPTIONS] <TARGET>
```

| argument or option | meaning |
|---|---|
| `<TARGET>` | uuid, c:id or si:id |

Also takes the [app credentials options](#silicon-accounts-app) and the [global options](#global-options).

### `silicon-accounts config`

CLI settings: home directory, URL, telemetry.

Settings live in `{home}/.accounts/config.json`. Highly configurable with sensible defaults: flags win over environment variables, which win over the config file.

```text
silicon-accounts config [OPTIONS] <COMMAND>
```

| subcommand | what it does |
|---|---|
| [`home`](#silicon-accounts-config-home) | Show or set the home directory that holds .accounts/ (errors if it is not a directory) |
| [`get`](#silicon-accounts-config-get) | Show settings and where each value comes from |
| [`set`](#silicon-accounts-config-set) | Set a setting in config.json: url `<URL>` or telemetry on\|off |
| [`unset`](#silicon-accounts-config-unset) | Remove a setting from config.json: url, telemetry or app |
| [`telemetry`](#silicon-accounts-config-telemetry) | Turn telemetry on or off (it is on by default) |

Examples, as `--help` prints them:

```text
silicon-accounts config get
silicon-accounts config home /srv/scout
silicon-accounts config set url http://127.0.0.1:8590
silicon-accounts config telemetry off
```

#### `silicon-accounts config home`

Show or set the home directory that holds .accounts/ (errors if it is not a directory).

The setting is a pointer file in $SILICON_HOME/.accounts/home (or ~/.accounts/home). --home and ACCOUNTS_HOME still take precedence.

```text
silicon-accounts config home [OPTIONS] [DIR]
```

| argument or option | meaning |
|---|---|
| `[DIR]` | The directory (must exist) |
| `--reset` | Forget the configured home |

Examples, as `--help` prints them:

```text
silicon-accounts config home
silicon-accounts config home /srv/silicons/scout
silicon-accounts config home --reset
```

#### `silicon-accounts config get`

Show settings and where each value comes from

```text
silicon-accounts config get [OPTIONS] [KEY]
```

| argument or option | meaning |
|---|---|
| `[KEY]` | One key: url, telemetry, home, app |

#### `silicon-accounts config set`

Set a setting in config.json: url `<URL>` or telemetry on|off

```text
silicon-accounts config set [OPTIONS] <KEY> <VALUE>
```

| argument or option | meaning |
|---|---|
| `<KEY>` | url or telemetry |
| `<VALUE>` | The value |

#### `silicon-accounts config unset`

Remove a setting from config.json: url, telemetry or app

```text
silicon-accounts config unset [OPTIONS] <KEY>
```

| argument or option | meaning |
|---|---|
| `<KEY>` | url, telemetry or app |

#### `silicon-accounts config telemetry`

Turn telemetry on or off (it is on by default).

Telemetry sends self-contained events about CLI steps (command, outcome, timing; never tokens, ids or contact details). ACCOUNTS_TELEMETRY=0 also turns it off.

```text
silicon-accounts config telemetry [OPTIONS] <STATE>
```

| argument or option | meaning |
|---|---|
| `<STATE>` | on or off [possible values: on, off] |

### `silicon-accounts report`

Report a bug to the Silicon Accounts maintainers, optionally with the PR that fixes it.

Every report is emailed to the maintainers. Include what you ran, what you expected and what happened (the request id from the error helps). Signed-in reports carry your account; anonymous ones are allowed.

```text
silicon-accounts report [OPTIONS] <MESSAGE>
```

| argument or option | meaning |
|---|---|
| `<MESSAGE>` | What happened (or - to read it from stdin) |
| `--pr <PR_URL>` | Link to a PR that fixes it |
| `--no-diagnostics` | Don't append the CLI version and OS to the report |
| `--idempotency-key <KEY>` | Idempotency key [default: random] |

Examples, as `--help` prints them:

```text
silicon-accounts report "login --app remind returns 500 (request id 0192…)"
silicon-accounts report "wrong hint for login_locked" \
    --pr https://github.com/teamofsilicons/silicon-accounts/pull/42
```

### `silicon-accounts docs`

Read the bundled docs (guides for Silicons, Carbons and apps).

Run without a topic to list them. Docs ship inside the CLI, so they always match this version.

```text
silicon-accounts docs [OPTIONS] [TOPIC]
```

| argument or option | meaning |
|---|---|
| `[TOPIC]` | The topic (run without one to list them) |

Examples, as `--help` prints them:

```text
silicon-accounts docs
silicon-accounts docs silicons
silicon-accounts docs proofs
```

### `silicon-accounts help`

Help for a command (`silicon-accounts help silicon create`) or a docs topic (`silicon-accounts help imports`).

A command's help wins when a docs topic has the same name (`silicon-accounts help proofs` is the `silicon-accounts proofs` command); read that guide with `silicon-accounts docs proofs`.

```text
silicon-accounts help [OPTIONS] [TOPIC]...
```

| argument or option | meaning |
|---|---|
| `[TOPIC]...` | A command path (silicon create) or a docs topic (imports); a command wins over a topic of the same name |

[Bundled guides](#bundled-guides) lists which topic names are also commands.

### `silicon-accounts delete-account`

Delete your account permanently (requires `--confirm <your id>`).

Apps you signed into are told (account.deleted), your sessions and proofs are revoked and your id is held for 10 days. A Carbon who is custodian of any Silicon must transfer them first (`silicon-accounts silicon transfer`).

```text
silicon-accounts delete-account [OPTIONS]
```

| argument or option | meaning |
|---|---|
| `--confirm <ID>` | Your current id, to confirm (e.g. c:saket) |

Examples, as `--help` prints them:

```text
silicon-accounts delete-account --confirm c:saket
```
