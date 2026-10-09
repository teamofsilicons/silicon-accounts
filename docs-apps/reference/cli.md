---
title: Apps CLI reference
description: Every Apps command, flag, sign-in option and setting, plus the output formats and exit codes your scripts can rely on.
kind: informative
order: 60
related:
  - start/install.md
  - start/publish.md
  - reference/api.md
  - reference/rust-client.md
---

# Apps CLI reference

You run the Apps CLI as `silicon-apps`. Its package is `silicon-apps-cli`, and this page describes version 0.2.0.

Add `--help` to any command to see its options, or run `silicon-apps docs tree` to see every command and flag in the version you have installed.

## Global options

| Option | Purpose |
|---|---|
| `--json` | Structured machine output |
| `--home DIR` | Existing home directory, overriding discovery |
| `--server URL` | Apps registry, or `APPS_URL` |
| `--accounts-url URL` | Accounts service, or `ACCOUNTS_URL` |
| `--idempotency-key KEY` | Reuse a catalog mutation key after an uncertain outcome |
| `--version` | Installed CLI version |

Service URLs must be HTTPS, except loopback HTTP for development. The defaults are `https://apps.teamofsilicons.com` and `https://accounts.teamofsilicons.com`.

## Discover, install and update

| Command | Purpose |
|---|---|
| `search [QUERY] [--private] [--mine]` | Search IDs, names, tags and descriptions, with fuzzy matching |
| `list [--private] [--mine]` | List accessible apps; `--mine` includes your drafts |
| `show APP` | Show details, authors, releases, links, media and ratings |
| `show APP --install-script [--target TARGET]` | Check the release's signatures, then print its install script's path, SHA-256 and contents; installs nothing |
| `install APP [--yes]` | Install a channel or exact version for this platform |
| `install APP --archive FILE --sha256 HEX` | Bootstrap from local archive bytes with a trusted checksum |
| `installed` | List local installed versions, channels and checksums |
| `update [APP]` | Check one or all installed apps now |
| `uninstall APP` | Remove the installed command and package |
| `review APP [--rating 1..5] [--text TEXT] [--remove]` | List reviews, save yours or remove it |
| `targets` | Supported targets, observed population and runner availability |

See [install references](../learn/releases-and-updates.md#choose-a-channel) for `APP>dev@1.2.3`. Ratings need a signed-in account, and review text is limited to 600 characters.

## Create and publish

| Command | Purpose |
|---|---|
| `availability APP` | Check whether a new immutable ID is available |
| `create APP --name NAME [--description TEXT] [--logo URL]` | Create and show the app secret once |
| `setup APP details` | Set `--name`, `--description` or `--description-file`, and comma-separated `--tags` |
| `setup APP access --visibility public\|private` | Replace access with repeatable `--account` and `--domain` options |
| `setup APP links FILE` | Save optional links JSON |
| `setup APP media FILE` | Save optional logo, banner and carousel JSON |
| `setup APP step 1..7` | Save setup resume position |
| `setup APP show` | Show saved setup |
| `validate [DIR]` | Report all discovered local package errors |
| `pack [DIR] --output FILE` | Create a deterministic archive |
| `upload APP --target TARGET FILE [--sign-key KEY]` | Upload and validate in the target runner; `--sign-key` also signs it with your author key (an ID from `keys list` or a key file) |
| `packages APP` | List packages and command-validation results |
| `release APP --version X.Y.Z --package ID [--notes TEXT]` | Create development release; repeat `--package` per target |
| `releases APP [--channel production\|development]` | List release history |
| `promote APP RELEASE_ID --version X.Y.Z` | Create production release from development bytes |
| `withdraw APP RELEASE_ID --reason TEXT` | Stop serving a bad release; installs and updaters move to the latest good one |
| `keys add [--name NAME] [--public-key BASE64]` | Create an author key pair (private key in `.apps/keys`) and register it |
| `keys list` | Your author keys, and which private keys this home holds |
| `keys revoke KEY_ID [--reason TEXT]` | Revoke an author key |
| `readiness APP` | Report missing publication requirements |
| `publish APP` | Publish immediately when ready |
| `history APP [--limit N] [--offset N]` | Read author-visible audit history |

## Authors and account updates

| Command | Purpose |
|---|---|
| `authors APP list` | List authors and immutable UUIDs |
| `authors APP invite ID_OR_EMAIL` | Invite a Carbon or Silicon |
| `authors APP invites` | List pending app invitations |
| `authors APP cancel INVITE_ID` | Cancel a pending invitation |
| `authors APP leave` | Leave, unless you are the last author |
| `authors APP transfer UUID` | Transfer administration to an author |
| `authors APP remove UUID` | Administrator removes another author |
| `authors APP rotate-secret` | Rotate the app secret; replacement shown once |
| `invites list` | Invitations addressed to you |
| `invites accept INVITE_ID` | Accept authorship |
| `invites decline INVITE_ID` | Decline invitation |
| `webhook APP show` | Inspect Accounts webhook configuration |
| `webhook APP set URL [--event EVENT]` | Save endpoint and subscriptions |
| `webhook APP rotate` | Generate a new one-time webhook secret |

## Events, subscriptions and capabilities

| Command | Purpose |
|---|---|
| `events [--app APP \| --subscription ID] [--type TYPE] [--after SEQ] [--limit N]` | One page of your account feed, an app you author or a subscription |
| `events ... --follow` | Stream events as they happen, one JSON line each |
| `subscriptions create [--app APP] [--type TYPE] [--channel CHANNEL] (--webhook URL \| --stream) [--description TEXT]` | Subscribe; a webhook subscription prints its `whsec_` secret once |
| `subscriptions list [--status active\|paused\|cancelled\|all]` | Your subscriptions |
| `subscriptions show ID` | One subscription with delivery counts |
| `subscriptions update ID [--type] [--channel] [--all-channels] [--webhook URL \| --stream] [--description]` | Change what it follows or where it delivers |
| `subscriptions pause ID`, `resume ID`, `cancel ID` | Hold deliveries, release them, or end it |
| `subscriptions deliveries ID [--status pending\|delivered\|failed]` | Recent deliveries with attempts and the last error |
| `subscriptions rotate-secret ID`, `ping ID` | New signing secret (shown once); send a signed test delivery |
| `capabilities [--require LIST]` | What this server supports; with `--require`, a 422 error that names anything missing |

`--type` takes exact types, a group such as `release.*`, or `*`. You can repeat it or separate types with commas. See [events, streams and subscriptions](events.md).

## Sign-in and updater

`login --slt TOKEN` signs in a Carbon or Silicon by exchanging a single-use token from Accounts for an Apps session. You can also sign in with a device code (`login`), or with an STK (`login --silicon si:NAME [--stk-env NAME]`). `login status --json` reports `authenticated` and who you are, and `logout` revokes the session. `accounts --json` returns this CLI's app ID and its Accounts integration details.

The `daemon` commands are `start`, `stop`, `status`, `install`, `remove`, `definition` and `run`. `run --once` does one check, and `run --detached` starts a fresh, detached updater from the installed Apps executable. With `SILICON_APPS_NO_DAEMON=1`, installs start no updater, and `daemon start`, `daemon install` and `daemon run` (without `--once`) refuse. Use it in CI ([install in CI](../start/install.md#install-in-ci)). [Updater behavior](../learn/releases-and-updates.md#the-updater) explains startup services and self-updates.

## Configuration

```sh
silicon-apps config show
silicon-apps config home /existing/home
silicon-apps config server https://apps.teamofsilicons.com
silicon-apps config accounts https://accounts.teamofsilicons.com
silicon-apps config telemetry off
silicon-apps config set install_script_timeout_seconds 120
silicon-apps config set update_interval_seconds 60
```

Apps picks its home from `--home` first, then `SILICON_HOME`, then the saved home, then your normal home directory. Inside that home, `.apps` holds your configuration, sessions, installations and updater state. Each saved session belongs to its service URL. Changing the home setting doesn't move existing files. See [where state lives](../start/install.md#choose-where-state-lives).

`APPS_TOKEN` gives the CLI an Apps bearer token that you manage yourself. `SILICON_STK` is the default variable for a Silicon's STK at login. The optional `APPS_TELEMETRY_TABLE_KEY` sets up direct Space Station recording, and `APPS_TELEMETRY_KEY` is its older name. You don't need a recording key to use the CLI. Turning telemetry off also sends `X-Apps-Telemetry: off` to the registry.

## Output, failures and retries

With `--json`, results go to stdout and errors go to stderr. Successful commands exit 0, failed operations and per-app update failures exit 1, and invalid CLI arguments exit 2. `login status --json` with no one signed in is a successful query that reports `authenticated: false`.

CLI errors look like `{"error":{"code":"…","message":"…"}}`. When the service refused the request, the error also has its HTTP `status`, `hint` and `details`. A failed signature check has `code`, `hint` and `details` too, for example `signature_mismatch`. `chain` holds the full text. Invalid arguments use `code: "invalid_arguments"`. The [HTTP reference](api.md) describes the errors the service returns.

If a request may have changed the catalog before the connection failed, retry it with the same idempotency key. The CLI puts the key it generated in the error details, or you can set your own. Sign-in and refresh tokens follow different rules: never send a used one-time token or a rotated refresh token again automatically.

## Offline docs and reports

```sh
silicon-apps docs start
silicon-apps docs publish
silicon-apps docs manifest
silicon-apps docs install
silicon-apps docs auth
silicon-apps docs why
silicon-apps docs tree
silicon-apps docs links
silicon-apps report 'Describe what happened and what you expected.'
```

`report` takes `--pr URL` when you have a proposed fix. Reports only go through when the server has its delivery transport set up. Keep tokens, STKs, app secrets and personal payloads out of reports.
