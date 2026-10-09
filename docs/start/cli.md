---
title: Use the silicon-accounts CLI
description: Install the silicon-accounts CLI, sign in, and drive it from your terminal or your scripts. See where it keeps your session and how to read its errors.
kind: instructive
order: 23
related:
  - reference/cli.md
  - start/silicon-account.md
  - start/silicon-sign-in-to-apps.md
  - start/custodians.md
  - reference/rust-client.md
---

# Use the silicon-accounts CLI

The `silicon-accounts` CLI is how Carbons and Silicons use Silicon Accounts from a terminal. You sign in with it, look after your account and set up your apps.

Add `--help` to any command to see how it works, and `--json` when a script needs to read the output. If a command fails, the error tells you what went wrong and what to try next.

Every CLI operation goes through the [`silicon-accounts-client`](../reference/rust-client.md) Rust package, and you can use that same package in your own Rust code.

```sh
silicon-accounts --help                                                      # the whole command tree
printf '%s' "$STK" | silicon-accounts login --silicon si:scout --stk-stdin   # sign a Silicon in
silicon-accounts login status --json                                         # read the authenticated field
```

```json
{
  "authenticated": true,
  "display_name": "Scout",
  "expires_at": "2026-10-07T03:01:30.006Z",
  "id": "si:scout",
  "kind": "silicon",
  "refresh_expires_at": "2029-03-25T02:31:29.998Z",
  "url": "https://accounts.teamofsilicons.com",
  "uuid": "8HV",
  "verified": true
}
```

## Install

Install Silicon Apps first with the [installer for your system](/docs/apps/start/install), then run:

```sh
silicon-apps install silicon-accounts
silicon-accounts --version
```

That installs the latest production release for your system, and Silicon Apps keeps it up to date from then on. You don't need Rust, and Accounts doesn't run an updater of its own. Your existing settings and sessions stay in `.accounts`.

If you'd rather build it from source, install Rust 1.98 or later and run `cargo install silicon-accounts-cli`. That puts the `silicon-accounts` command in `~/.cargo/bin`.

## Point it at a Silicon Accounts instance

The CLI talks to `https://accounts.teamofsilicons.com` unless you tell it otherwise. The first match wins:

1. `--url <URL>` on the command;
2. `ACCOUNTS_URL`;
3. `silicon-accounts config set url <URL>`, stored in `{home}/.accounts/config.json`;
4. the URL of the stored session, or of a code sign-in waiting for its code;
5. `https://accounts.teamofsilicons.com`.

For local development, follow [Run it yourself](../index.md#run-it-yourself) and set `ACCOUNTS_URL=http://localhost:8590`. To use our hosted service, leave the URL unset.

Plain `http://` is accepted only for this machine (`localhost`, `*.localhost`, `127.0.0.0/8`,
`::1`), so tokens and STKs never cross a network unencrypted. On a network you trust,
`ACCOUNTS_ALLOW_INSECURE_HTTP=1` lifts that. A session belongs to the URL it was created at. Point a
command at another URL and it answers `not_signed_in` (`You are signed in to … as si:scout, but this command
targets …`) until you sign in there too.

## Sign in

| who | command |
|---|---|
| a Silicon | `printf '%s' "$STK" \| silicon-accounts login --silicon si:scout --stk-stdin`, or `ACCOUNTS_SILICON` and `ACCOUNTS_STK` |
| a Carbon with a browser | `silicon-accounts login`: shows a code like `WDJB-MJHT` and opens `accounts.teamofsilicons.com/device`, where you approve it |
| a Carbon without a browser | `silicon-accounts login --email you@example.com` (or `--phone`), then type the 6-digit code |
| a Carbon in a script | `silicon-accounts login --email you@example.com`, then `silicon-accounts login --email you@example.com --code 123456` |

You can also approve a browser code from another machine where you're already signed in:
`silicon-accounts device approve WDJB-MJHT`. `silicon-accounts login --app <app_id>` prints a short-lived token for
an app, signing you in first when it needs to; [Sign a Silicon into an app](silicon-sign-in-to-apps.md)
covers it. `silicon-accounts logout` revokes this session and deletes the stored tokens. Your other
sessions stay signed in (`silicon-accounts sessions list` shows them).

## Script it

We built the CLI to be driven by Silicons and scripts just as much as by Carbons.

**Results on stdout, everything else on stderr.** Progress, notices and the suggested next commands
(`Next:`) go to stderr, so `$(…)` captures only the result. `-q` drops the extras, and results and
errors still print.

**`--json` everywhere.** With `--json`, stdout holds one JSON document: the result, or the error.
Errors keep the same shape:

```json
{
  "error": {
    "code": "login_locked",
    "details": {
      "retry_after_seconds": 54
    },
    "exit_code": 6,
    "hint": "Wait until the lock ends (details.retry_after_seconds), then sign in with the correct STK. If the STK is lost, the Silicon's custodian can rotate it (`silicon-accounts silicon rotate-stk`).",
    "message": "Sign-in to si:mapper is locked for 54 more seconds because 10 wrong STKs were sent in a row.",
    "request_id": "01a11437-fa72-7396-9e92-934ae46183ec",
    "status": 423
  }
}
```

`code` is stable and safe to branch on. `message` says what happened and why, and `hint` says what
to do. `status` and `request_id` come from us (quote the request id in a bug report), and `details`
carries the specifics, such as `retry_after_seconds`, `suggestions` or `fields`. A command that has
to show you something before it finishes writes it to stderr as one JSON object per line. That's the
browser code of `silicon-accounts login` (`{"event":"device_code",…}`), or the new account of
`silicon-accounts silicon create --wait` (`{"event":"silicon_created",…,"stk":"stk-…"}`), written before
the wait starts so the STK is never lost if the wait is cut short.

**Exit codes you can branch on:**

| code | meaning |
|---|---|
| `0` | success |
| `1` | failure: network, service error, an unexpected response; also a custodian request that ended without acceptance, and a wait that timed out |
| `2` | invalid input (flags, values, files); also "not valid" from `silicon-accounts app proof verify`, `app token verify` and `app token introspect` |
| `3` | sign-in required, credentials refused, or not allowed (including the wrong kind of account) |
| `4` | not found |
| `5` | conflict: taken, already exists, changed meanwhile; also an id that is taken, reserved or a reserved word in `silicon-accounts id available` |
| `6` | rate limited or locked: wait `details.retry_after_seconds` |
| `130` | interrupted with Ctrl-C |

A few commands use exit codes as answers. `silicon-accounts login status` exits `1` when you're not signed in; with `--json`, it exits `0` and reports `authenticated: false`.
`silicon-accounts id available` exits `0` (free), `5` (taken, reserved, or a reserved word) or `2`
(not a valid id).

**Secrets on stdin, never as arguments.** Arguments are visible to every process on the machine
and land in shell history. Use `--stk-stdin`, `--app-secret-stdin` or `--secret-stdin`, the
`ACCOUNTS_STK` and `ACCOUNTS_APP_SECRET` variables, or `-` in place of a token argument:

```sh
printf '%s' "$REFRESH_TOKEN" | silicon-accounts app token refresh -
```

**No prompts in scripts.** The CLI only asks you questions when stdin and stderr are terminals and
`--json` is off. Otherwise a missing value is an error that names the flag to pass, for example
`No STK was given for si:scout.` with the hint `Pipe it with --stk-stdin, set ACCOUNTS_STK, or pass
--stk.`

**Two CLIs, two STK variables.** `silicon-accounts` reads the STK from `ACCOUNTS_STK`, but
`silicon-apps login --silicon` reads `SILICON_STK` by default. A Silicon that signs in with both
sets both variables, or passes `--stk-env ACCOUNTS_STK` to `silicon-apps`. When
`ACCOUNTS_SILICON_KEY` (a key file) and `ACCOUNTS_STK` are both set, `silicon-accounts` signs in
with the key.

## Give every Silicon its own home

The CLI keeps its state in `{home}/.accounts/`. To find the home, the first match wins:

1. `--home <DIR>`;
2. `ACCOUNTS_HOME`;
3. the directory set with `silicon-accounts config home <DIR>`, remembered in a one-line file
   `{base}/.accounts/home`, where `{base}` is `$SILICON_HOME` or `~`;
4. `SILICON_HOME`;
5. `~`.

A home holds one session, so every Silicon on a machine needs its own. The easiest way is
`SILICON_HOME`:

```sh
mkdir -p /srv/silicons/scout
SILICON_HOME=/srv/silicons/scout silicon-accounts config home
```

```text
home    /srv/silicons/scout
source  SILICON_HOME
state   /srv/silicons/scout/.accounts
```

Whatever names the home has to point at an existing directory. Anything else stops the command
before it does anything, and it tells you what's wrong and where the value came from (exit code `2`):

```text
error: not a directory: /srv/silicons/nope (it does not exist; set by SILICON_HOME)
hint: Point it at an existing directory (create it first with mkdir -p), or reset it: `silicon-accounts config home --reset` for the configured home, or unset the variable.
```

What lives there:

| file | holds |
|---|---|
| `session.json` | the signed-in account and its tokens |
| `config.json` | `url`, `telemetry` and `app` settings |
| `requests/<request-id>.json` | the polling token of each Silicon self-created from this home |
| `apps/<app_id>.json` | an app secret stored by `silicon-accounts app use … --secret-stdin` |
| `login-challenge.json` | a code sign-in waiting for its code |
| `session.lock` | the lock that serializes token refreshes |

Files are written atomically with mode 0600 in a 0700 directory, because they hold tokens and
secrets. Many processes can use one home at once. Refreshes happen under the lock, because refresh
tokens rotate and presenting a used one would end the session. `silicon-accounts config home <DIR>` doesn't
move an existing session, so sign in again in the new home.

## Settings

```sh
silicon-accounts config get
```

```text
url        https://accounts.teamofsilicons.com  (from default)
telemetry  on  (from default)
home       /srv/silicons/scout  (from SILICON_HOME)
state dir  /srv/silicons/scout/.accounts
app        none
signed in  si:scout at https://accounts.teamofsilicons.com
version    0.4.0
```

| command | does |
|---|---|
| `silicon-accounts config get [url\|telemetry\|home\|app]` | every setting with where its value comes from (`--json` gives `{"value","source"}` per key) |
| `silicon-accounts config set url <URL>` | stores the URL in `config.json` |
| `silicon-accounts config set telemetry on\|off`, `silicon-accounts config telemetry off` | stores the telemetry choice |
| `silicon-accounts config unset url\|telemetry\|app` | removes a setting; the default applies again |
| `silicon-accounts config home [<DIR>] [--reset]` | shows, sets or forgets the configured home |

Flags win over environment variables, which win over `config.json`.

## Telemetry

The CLI reports command activity to Space Station, the event service Team of Silicons runs for its own products. It never talks to Space Station directly: it sends its events to Silicon Accounts (`POST /v1/telemetry/events`, without your credentials), which forwards them. For a flow with several steps, it sends an event for each step, like `login.silicon.started`, `login.slt.issued` or `silicon.create.requested`. A final `cli.command` event records the result, the exit and error codes, the duration, the CLI version, the operating system and the architecture. It also records whether you used `--json` and whether the caller was a Carbon or a Silicon.

These events don't include tokens, STKs, secrets, account ids, uuids or contact details. The only identifier they can carry is the app id a short-lived token was requested for. Silicon Accounts checks that too: it forwards only the CLI's own step names, command paths, fields and words, and anything else as `other` or not at all, so even a changed or older CLI can't send more. Commands that never contact us send no events, and the CLI waits at most 1.5 seconds to send them.

Telemetry is on by default. Turn it off with `silicon-accounts config telemetry off`, or for a single
process with `ACCOUNTS_TELEMETRY=0` (the variable beats the setting). When it's off, every request
also carries `X-Accounts-Telemetry: off`, so the service records nothing about those requests
either. [Security](../learn/security.md#telemetry) says what the service itself records.

## Get help

```sh
silicon-accounts --help                 # every command, the bundled guides, environment, exit codes
silicon-accounts silicon create --help  # what it does, how it combines with other commands, examples
silicon-accounts help silicon create    # the same
silicon-accounts docs                   # the bundled guides; silicon-accounts docs silicons, silicon-accounts docs custodians, …
```

The guides ship inside the CLI, so they always match the version you have. The
[CLI reference](../reference/cli.md) has every command and option.

## Report a bug

```sh
silicon-accounts report "silicon-accounts login --app remind answered 500 (request id 01a11437-caf0-72cc-90e9-6a66e8ee1669)"
silicon-accounts report "wrong hint for login_locked" --pr https://github.com/teamofsilicons/silicon-accounts/pull/42
```

```text
Report 01a1143c-746a-7381-b51a-44f2076a78e5 sent: it is emailed to the Silicon Accounts maintainers (3 recipients).
```

Say what you ran, what you expected and what happened, and include the request id from the error.
Every report is emailed to the maintainers. A report sent while you're signed in names your account;
signed out, it's anonymous. We append the CLI version and operating system unless you pass
`--no-diagnostics`. If you fixed it yourself, pass the link to your pull request with `--pr` (https
only), and we'd be grateful. The repository is `github.com/teamofsilicons/silicon-accounts`, though
only its product contract is pushed there so far. You can send 5 reports per hour per network, each
up to 10,000 characters, and `-` reads the message from stdin.

## Next

- [CLI reference](../reference/cli.md): every command, option, environment variable and exit code.
- [Get a Silicon account](silicon-account.md) and [Sign a Silicon into an app](silicon-sign-in-to-apps.md).
