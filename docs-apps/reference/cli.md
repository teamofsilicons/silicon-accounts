---
title: Apps CLI reference
description: Look up Apps commands, flags, sign-in options and settings. Find the output formats and exit codes to use in scripts.
kind: informative
order: 60
related:
  - start/install.md
  - start/publish.md
  - reference/api.md
  - reference/rust-client.md
---

# Apps CLI reference

Run the Apps CLI with the `silicon-apps` command. Its package name is `silicon-apps-cli`, and this reference describes version 0.1.9.

Add `--help` to any command to see its options. Run `silicon-apps docs tree` to see every command and flag in your installed version.

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
| `install APP [--yes]` | Install a channel or exact version for this platform |
| `install APP --archive FILE --sha256 HEX` | Bootstrap from local archive bytes with a trusted checksum |
| `installed` | List local installed versions, channels and checksums |
| `update [APP]` | Check one or all installed apps now |
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

`login --slt TOKEN` signs in a Carbon or Silicon by exchanging an Accounts-issued, single-use token for Apps. Other supported flows are device sign-in with `login` and STK sign-in with `login --silicon si:NAME [--stk-env NAME]`. `login status --json` reports `authenticated` and identity; `logout` revokes the session. `accounts --json` returns this CLI's app ID and Accounts integration information.

The `daemon` commands are `start`, `stop`, `status`, `install`, `remove`, `definition` and `run`. `run --once` performs one check; `run --detached` starts a fresh detached updater from the installed Apps executable. [Updater behavior](../learn/releases-and-updates.md#the-updater) explains startup services and self-updates.

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

Apps chooses its home from `--home` first, then `SILICON_HOME`, then the saved home, then your normal home directory. It stores configuration, sessions, installations and updater state inside `.apps` in that directory. Each saved session belongs to its service URL. Changing the home setting does not move existing files. See [where state lives](../start/install.md#choose-where-state-lives).

`APPS_TOKEN` supplies an externally managed Apps bearer token. `SILICON_STK` is the default STK variable for Silicon login. The optional `APPS_TELEMETRY_TABLE_KEY` configures direct Space Station recording; `APPS_TELEMETRY_KEY` is a legacy alias. No recording key is required to use the CLI. Telemetry opt-out also sends `X-Apps-Telemetry: off` to the registry.

## Output, failures and retries

With `--json`, results go to stdout and errors go to stderr. Successful commands exit 0; operation failures and per-app update failures exit 1; invalid CLI arguments exit 2. An unauthenticated `login status --json` is a successful status query reporting `authenticated: false`.

CLI errors use `{"error":{"message":"…"}}`. Invalid arguments also include `code: "invalid_arguments"`. The [HTTP reference](api.md) describes errors returned by the service.

If a request may have changed the catalog before the connection failed, retry it with the same idempotency key. The CLI includes its generated key in the error details, or you can set one yourself. Login and refresh tokens follow different rules: a used one-time token or a rotated refresh token must not be sent again automatically.

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

`report` accepts `--pr URL` for a proposed fix. Reports require the server's delivery transport. Keep tokens, STKs, app secrets and personal payloads out of reports.
