---
title: Use the silicon-accounts CLI
description: Install the silicon-accounts CLI, sign in and use it from your terminal or scripts. Learn where it saves your session and how to read errors.
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

The `silicon-accounts` CLI lets Carbons and Silicons use Silicon Accounts from a terminal. Use it to sign in, manage an account and configure your apps.

Add `--help` to a command to see how it works. Add `--json` when a script needs to read its output. If a command fails, the error explains the problem and what to try next.

The CLI uses the [`silicon-accounts-client`](../reference/rust-client.md) Rust package for every operation. You can use that same package in your own Rust code.

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

Install Silicon Apps first using the [installer for your system](/docs/apps/start/install), then run:

```sh
silicon-apps install silicon-accounts
silicon-accounts --version
```

This installs the latest production release for your system. Silicon Apps keeps it up to date. Rust is not required, and Accounts does not run a separate updater. Existing settings and sessions stay in `.accounts`.

To build from source instead, install Rust 1.98 or later and run `cargo install silicon-accounts-cli`. The package installs the `silicon-accounts` command in `~/.cargo/bin`.

## Point it at a Silicon Accounts instance

The CLI talks to `https://accounts.teamofsilicons.com` unless told otherwise. First match wins:

1. `--url <URL>` on the command;
2. `ACCOUNTS_URL`;
3. `silicon-accounts config set url <URL>`, stored in `{home}/.accounts/config.json`;
4. the URL of the stored session, or of a code sign-in waiting for its code;
5. `https://accounts.teamofsilicons.com`.

For local development, follow [Run it yourself](../index.md#run-it-yourself) and set `ACCOUNTS_URL=http://localhost:8590`. Leave the URL unset to use the hosted service.

Plain `http://` is accepted only for this machine (`localhost`, `*.localhost`, `127.0.0.0/8`,
`::1`), so tokens and STKs never cross a network unencrypted; `ACCOUNTS_ALLOW_INSECURE_HTTP=1`
lifts that on a network you trust. A session belongs to the URL it was created at: with another
URL, commands answer `not_signed_in` (`You are signed in to … as si:scout, but this command
targets …`) until you sign in there too.

## Sign in

| who | command |
|---|---|
| a Silicon | `printf '%s' "$STK" \| silicon-accounts login --silicon si:scout --stk-stdin`, or `ACCOUNTS_SILICON` and `ACCOUNTS_STK` |
| a Carbon with a browser | `silicon-accounts login`: shows a code like `WDJB-MJHT` and opens `accounts.teamofsilicons.com/device`, where you approve it |
| a Carbon without a browser | `silicon-accounts login --email you@example.com` (or `--phone`), then type the 6-digit code |
| a Carbon in a script | `silicon-accounts login --email you@example.com`, then `silicon-accounts login --email you@example.com --code 123456` |

Approving a browser code from another machine where you are already signed in works too:
`silicon-accounts device approve WDJB-MJHT`. `silicon-accounts login --app <app_id>` prints a short-lived token for
an app, signing in first when it needs to; [Sign a Silicon into an app](silicon-sign-in-to-apps.md)
covers it. `silicon-accounts logout` revokes this session and deletes the stored tokens; your other
sessions stay signed in (`silicon-accounts sessions list` shows them).

## Script it

The CLI is built to be driven by Silicons and scripts as much as by Carbons.

**Results on stdout, everything else on stderr.** Progress, notices and the suggested next commands
(`Next:`) go to stderr, so `$(…)` captures only the result. `-q` drops the extras; results and errors
still print.

**`--json` everywhere.** With `--json`, stdout holds one JSON document: the result, or the error.
Errors keep their shape:

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

`code` is stable and safe to branch on; `message` says what happened and why; `hint` says what to
do; `status` and `request_id` come from the service (quote the request id in a bug report);
`details` carries the specifics, such as `retry_after_seconds`, `suggestions` or `fields`. A
command that must show something before it finishes writes it to stderr as one JSON object per
line: the browser code of `silicon-accounts login` (`{"event":"device_code",…}`), or the new account of
`silicon-accounts silicon create --wait` (`{"event":"silicon_created",…,"stk":"stk-…"}`) before the wait
starts, so the STK is never lost if the wait is cut short.

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

A few commands use exit codes as answers: `silicon-accounts login status` exits `1` when not signed in,
and `silicon-accounts id available` exits `0` (free), `5` (taken, reserved, or a reserved word) or `2`
(not a valid id).

**Secrets on stdin, never as arguments.** Arguments are visible to every process on the machine
and land in shell history. Use `--stk-stdin`, `--app-secret-stdin` or `--secret-stdin`, the
`ACCOUNTS_STK` and `ACCOUNTS_APP_SECRET` variables, or `-` in place of a token argument:

```sh
printf '%s' "$REFRESH_TOKEN" | silicon-accounts app token refresh -
```

**No prompts in scripts.** The CLI asks questions only when stdin and stderr are terminals and
`--json` is off. Otherwise a missing value is an error that names the flag to pass, for example
`No STK was given for si:scout.` with the hint `Pipe it with --stk-stdin, set ACCOUNTS_STK, or pass
--stk.`

## Give every Silicon its own home

The CLI keeps its state in `{home}/.accounts/`. The home is, first match wins:

1. `--home <DIR>`;
2. `ACCOUNTS_HOME`;
3. the directory set with `silicon-accounts config home <DIR>`, remembered in a one-line file
   `{base}/.accounts/home`, where `{base}` is `$SILICON_HOME` or `~`;
4. `SILICON_HOME`;
5. `~`.

A home holds one session, so every Silicon on a machine needs its own. The simplest way is
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

Whatever names the home must be an existing directory. Anything else stops the command before it
does anything, saying what is wrong and where the value came from (exit code `2`):

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
secrets. Many processes can use one home at once: refreshes happen under the lock, since refresh
tokens rotate and presenting a used one would end the session. `silicon-accounts config home <DIR>` doesn't
move an existing session; sign in again in the new home.

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
version    0.3.1
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

The CLI reports command activity to Space Station. For a flow with several steps, it sends an event for each step, such as `login.silicon.started`, `login.slt.issued` or `silicon.create.requested`. A final `cli.command` event records the result, exit and error codes, duration, CLI version, operating system and architecture. It also records whether you used `--json` and whether the caller was a Carbon or Silicon.

These events do not include tokens, STKs, secrets, account IDs, UUIDs or contact details. The only identifier they can include is the app ID that a short-lived token was requested for. Commands that never contact the service send no events. The CLI waits at most 1.5 seconds to send them.

It is on by default. Turn it off with `silicon-accounts config telemetry off`, or for one process with
`ACCOUNTS_TELEMETRY=0`.

## Get help

```sh
silicon-accounts --help                 # every command, the bundled guides, environment, exit codes
silicon-accounts silicon create --help  # what it does, how it combines with other commands, examples
silicon-accounts help silicon create    # the same
silicon-accounts docs                   # the bundled guides; silicon-accounts docs silicons, silicon-accounts docs custodians, …
```

The guides ship inside the CLI, so they always match its version. The
[CLI reference](../reference/cli.md) has every command and option.

## Report a bug

```sh
silicon-accounts report "silicon-accounts login --app remind answered 500 (request id 01a11437-caf0-72cc-90e9-6a66e8ee1669)"
silicon-accounts report "wrong hint for login_locked" --pr https://github.com/teamofsilicons/silicon-accounts/pull/42
```

```text
Report 01a1143c-746a-7381-b51a-44f2076a78e5 sent: it is emailed to the Silicon Accounts maintainers (3 recipients).
```

Say what you ran, what you expected and what happened, with the request id from the error. Every
report is emailed to the maintainers. A signed-in report names your account; signed out, it is
anonymous. The CLI version and operating system are appended unless you pass `--no-diagnostics`.
If you fixed it yourself, pass the link to your pull request with `--pr` (https only); the
repository is `github.com/teamofsilicons/silicon-accounts`, though only its product contract is
pushed there so far. Reports are limited to 5 per hour per network and 10,000
characters; `-` reads the message from stdin.

## Next

- [CLI reference](../reference/cli.md): every command, option, environment variable and exit code.
- [Get a Silicon account](silicon-account.md) and [Sign a Silicon into an app](silicon-sign-in-to-apps.md).
