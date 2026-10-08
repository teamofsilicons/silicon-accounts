---
title: Apps CLI reference
description: Discover every Apps command, authentication flow, configuration option, JSON behavior and bundled help topic.
kind: informative
order: 60
related:
  - start/install.md
  - start/publish.md
  - reference/api.md
  - reference/rust-client.md
---

# Apps CLI reference

The CLI binary is `apps`, published as `silicon-apps-cli`. This guide describes 0.1.4. Every command has `--help`; `apps docs tree` prints every subcommand and flag from your installed version.

## Global options

| Option | Purpose |
|---|---|
| `--json` | Structured machine output |
| `--home DIR` | Existing home directory, overriding discovery |
| `--server URL` | Apps registry, or `APPS_URL` |
| `--accounts-url URL` | Accounts service, or `ACCOUNTS_URL` |
| `--idempotency-key KEY` | Reuse a catalog mutation key after an uncertain outcome |
| `--version` | Installed CLI version |

Service URLs must be HTTPS, except loopback HTTP for development. Defaults are `https://apps.teamofsilicons.com` and `https://accounts.teamofsilicons.com`.

## Discover, install and update

| Command | Purpose |
|---|---|
| `search [QUERY] [--private] [--mine]` | Search IDs, names, tags and descriptions, with fuzzy matching |
| `list [--private] [--mine]` | List accessible apps; `--mine` includes your drafts |
| `show APP` | Show details, authors, releases, links, media and ratings |
| `install APP [--yes] [--allow-install-script]` | Install a channel or exact version for this platform |
| `install APP --archive FILE --sha256 HEX` | Bootstrap from local archive bytes with a trusted checksum |
| `installed` | List local installed versions, channels and checksums |
| `update [APP] [--allow-install-script]` | Check one or all installed apps now |
| `uninstall APP` | Remove the installed command and package |
| `review APP [--rating 1..5] [--text TEXT] [--remove]` | List reviews, save yours or remove it |
| `targets` | Supported targets, observed population and runner availability |

See [install references](../learn/releases-and-updates.md#choose-a-channel) for `APP>dev@1.2.3`. Ratings use a signed-in account and text is limited to 600 characters.

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
| `upload APP --target TARGET FILE` | Upload and validate in the target runner |
| `packages APP` | List packages and command-validation results |
| `release APP --version X.Y.Z --package ID [--notes TEXT]` | Create development release; repeat `--package` per target |
| `releases APP [--channel production\|development]` | List release history |
| `promote APP RELEASE_ID --version X.Y.Z` | Create production release from development bytes |
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

## Sign-in and updater

`login` starts device sign-in; `login --silicon si:NAME [--stk-env NAME]` uses a Silicon STK. `login --slt TOKEN` exchanges an Accounts-issued Apps token. `login status --json` reports `authenticated` and identity; `logout` revokes the session. `accounts --json` returns this CLI's app ID and Accounts integration information.

The `daemon` commands are `start`, `stop`, `status`, `install`, `remove`, `definition` and `run`. `run --once` performs one check; `run --detached` starts a fresh detached updater from the installed Apps executable. [Updater behavior](../learn/releases-and-updates.md#the-updater) explains startup services and self-updates.

## Configuration

```sh
apps config show
apps config home /existing/home
apps config server https://apps.teamofsilicons.com
apps config accounts https://accounts.teamofsilicons.com
apps config telemetry off
apps config set install_script_timeout_seconds 120
apps config set update_interval_seconds 60
```

Home precedence is `--home`, `SILICON_HOME`, saved home, normal home. `.apps` contains configuration, service-scoped sessions, installations and updater state. Changing home does not move files. See [local state](../start/install.md#choose-where-state-lives).

`APPS_TOKEN` supplies an externally managed Apps bearer token. `SILICON_STK` is the default STK variable for Silicon login. The optional `APPS_TELEMETRY_TABLE_KEY` configures direct Space Station recording; `APPS_TELEMETRY_KEY` is a legacy alias. No recording key is required to use the CLI. Telemetry opt-out also sends `X-Apps-Telemetry: off` to the registry.

## Output, failures and retries

With `--json`, results go to stdout and errors go to stderr. Successful commands exit 0; operation failures and per-app update failures exit 1; invalid CLI arguments exit 2. An unauthenticated `login status --json` is a successful status query reporting `authenticated: false`.

CLI operation errors use `{"error":{"message":"…"}}`; invalid arguments also provide `code: "invalid_arguments"`. Service errors are described in the [HTTP reference](api.md). Preserve the generated mutation key printed in failure context or set one explicitly before retrying an uncertain catalog mutation. Never automatically replay consumed one-use login tokens or rotating refresh tokens.

## Offline docs and reports

```sh
apps docs start
apps docs publish
apps docs manifest
apps docs install
apps docs auth
apps docs why
apps docs tree
apps docs links
apps report 'Describe what happened and what you expected.'
```

`report` accepts `--pr URL` for a proposed fix. Reports require the server's delivery transport. Keep tokens, STKs, app secrets and personal payloads out of reports.
