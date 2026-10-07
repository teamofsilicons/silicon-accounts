---
title: Use the accounts CLI
description: Install the accounts CLI, sign in, script it with --json and exit codes, give every Silicon its own home, configure it, and report bugs.
kind: instructive
order: 23
related:
  - reference/cli.md
  - start/silicon-account.md
  - start/silicon-sign-in-to-apps.md
  - start/custodians.md
  - reference/rust-client.md
---

# Use the accounts CLI

`accounts` is the command line for Silicon Accounts, for Silicons and Carbons alike. It is built
only on the [`silicon-accounts-client`](../reference/rust-client.md) Rust package, so anything it
does, your own Rust code can do too. Every command explains itself with `--help`, prints
machine-readable output with `--json`, and says exactly what went wrong and what to do next when
it fails.

```sh
accounts --help                                                      # the whole command tree
printf '%s' "$STK" | accounts login --silicon si:scout --stk-stdin   # sign a Silicon in
accounts login status --json                                         # exit 0 signed in, 1 not
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

Silicon Apps installs the CLI and keeps it up to date. The CLI never updates itself, so there is
exactly one updater.

To build it from source, with Rust 1.98 or later, from a checkout of the repository:

```sh
cd /path/to/silicon-accounts               # your checkout
cargo install --path crates/cli --locked   # installs the `accounts` binary into ~/.cargo/bin
accounts --version                         # accounts 0.1.0
```

<!-- not-published-note: restore the git clone once the code is pushed -->
The repository's public home, `github.com/teamofsilicons/silicon-accounts`, holds only the
product contract (`understanding/`) so far (October 2026), so `git clone` gives you no `crates/`
to build: use the checkout you were given. A local stack ([Run it
yourself](../index.md#run-it-yourself)) also builds the CLI, as `target/debug/accounts`.

## Point it at a Silicon Accounts instance

The CLI talks to `https://accounts.teamofsilicons.com` unless told otherwise. First match wins:

1. `--url <URL>` on the command;
2. `ACCOUNTS_URL`;
3. `accounts config set url <URL>`, stored in `{home}/.accounts/config.json`;
4. the URL of the stored session, or of a code sign-in waiting for its code;
5. `https://accounts.teamofsilicons.com`.

<!-- not-deployed-note: remove once accounts.teamofsilicons.com is live -->
That default isn't deployed yet (October 2026), so with nothing set every command fails to
connect (`connection_failed`). Until it is, run your own stack ([Run it
yourself](../index.md#run-it-yourself)) and `export ACCOUNTS_URL=http://localhost:8590`.

Plain `http://` is accepted only for this machine (`localhost`, `*.localhost`, `127.0.0.0/8`,
`::1`), so tokens and STKs never cross a network unencrypted; `ACCOUNTS_ALLOW_INSECURE_HTTP=1`
lifts that on a network you trust. A session belongs to the URL it was created at: with another
URL, commands answer `not_signed_in` (`You are signed in to … as si:scout, but this command
targets …`) until you sign in there too.

## Sign in

| who | command |
|---|---|
| a Silicon | `printf '%s' "$STK" \| accounts login --silicon si:scout --stk-stdin`, or `ACCOUNTS_SILICON` and `ACCOUNTS_STK` |
| a Carbon with a browser | `accounts login`: shows a code like `WDJB-MJHT` and opens `accounts.teamofsilicons.com/device`, where you approve it |
| a Carbon without a browser | `accounts login --email you@example.com` (or `--phone`), then type the 6-digit code |
| a Carbon in a script | `accounts login --email you@example.com`, then `accounts login --email you@example.com --code 123456` |

Approving a browser code from another machine where you are already signed in works too:
`accounts device approve WDJB-MJHT`. `accounts login --app <app_id>` prints a short-lived token for
an app, signing in first when it needs to; [Sign a Silicon into an app](silicon-sign-in-to-apps.md)
covers it. `accounts logout` revokes this session and deletes the stored tokens; your other
sessions stay signed in (`accounts sessions list` shows them).

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
    "hint": "Wait until the lock ends (details.retry_after_seconds), then sign in with the correct STK. If the STK is lost, the Silicon's custodian can rotate it (`accounts silicon rotate-stk`).",
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
line: the browser code of `accounts login` (`{"event":"device_code",…}`), or the new account of
`accounts silicon create --wait` (`{"event":"silicon_created",…,"stk":"stk-…"}`) before the wait
starts, so the STK is never lost if the wait is cut short.

**Exit codes you can branch on:**

| code | meaning |
|---|---|
| `0` | success |
| `1` | failure: network, service error, an unexpected response; also a custodian request that ended without acceptance, and a wait that timed out |
| `2` | invalid input (flags, values, files); also "not valid" from `accounts app proof verify`, `app token verify` and `app token introspect` |
| `3` | sign-in required, credentials refused, or not allowed (including the wrong kind of account) |
| `4` | not found |
| `5` | conflict: taken, already exists, changed meanwhile; also an id that is taken, reserved or a reserved word in `accounts id available` |
| `6` | rate limited or locked: wait `details.retry_after_seconds` |
| `130` | interrupted with Ctrl-C |

A few commands use exit codes as answers: `accounts login status` exits `1` when not signed in,
and `accounts id available` exits `0` (free), `5` (taken, reserved, or a reserved word) or `2`
(not a valid id).

**Secrets on stdin, never as arguments.** Arguments are visible to every process on the machine
and land in shell history. Use `--stk-stdin`, `--app-secret-stdin` or `--secret-stdin`, the
`ACCOUNTS_STK` and `ACCOUNTS_APP_SECRET` variables, or `-` in place of a token argument:

```sh
printf '%s' "$REFRESH_TOKEN" | accounts app token refresh -
```

**No prompts in scripts.** The CLI asks questions only when stdin and stderr are terminals and
`--json` is off. Otherwise a missing value is an error that names the flag to pass, for example
`No STK was given for si:scout.` with the hint `Pipe it with --stk-stdin, set ACCOUNTS_STK, or pass
--stk.`

## Give every Silicon its own home

The CLI keeps its state in `{home}/.accounts/`. The home is, first match wins:

1. `--home <DIR>`;
2. `ACCOUNTS_HOME`;
3. the directory set with `accounts config home <DIR>`, remembered in a one-line file
   `{base}/.accounts/home`, where `{base}` is `$SILICON_HOME` or `~`;
4. `SILICON_HOME`;
5. `~`.

A home holds one session, so every Silicon on a machine needs its own. The simplest way is
`SILICON_HOME`:

```sh
mkdir -p /srv/silicons/scout
SILICON_HOME=/srv/silicons/scout accounts config home
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
hint: Point it at an existing directory (create it first with mkdir -p), or reset it: `accounts config home --reset` for the configured home, or unset the variable.
```

What lives there:

| file | holds |
|---|---|
| `session.json` | the signed-in account and its tokens |
| `config.json` | `url`, `telemetry` and `app` settings |
| `requests/<request-id>.json` | the polling token of each Silicon self-created from this home |
| `apps/<app_id>.json` | an app secret stored by `accounts app use … --secret-stdin` |
| `login-challenge.json` | a code sign-in waiting for its code |
| `session.lock` | the lock that serializes token refreshes |

Files are written atomically with mode 0600 in a 0700 directory, because they hold tokens and
secrets. Many processes can use one home at once: refreshes happen under the lock, since refresh
tokens rotate and presenting a used one would end the session. `accounts config home <DIR>` doesn't
move an existing session; sign in again in the new home.

## Settings

```sh
accounts config get
```

```text
url        https://accounts.teamofsilicons.com  (from default)
telemetry  on  (from default)
home       /srv/silicons/scout  (from SILICON_HOME)
state dir  /srv/silicons/scout/.accounts
app        none
signed in  si:scout at https://accounts.teamofsilicons.com
version    0.1.0
```

| command | does |
|---|---|
| `accounts config get [url\|telemetry\|home\|app]` | every setting with where its value comes from (`--json` gives `{"value","source"}` per key) |
| `accounts config set url <URL>` | stores the URL in `config.json` |
| `accounts config set telemetry on\|off`, `accounts config telemetry off` | stores the telemetry choice |
| `accounts config unset url\|telemetry\|app` | removes a setting; the default applies again |
| `accounts config home [<DIR>] [--reset]` | shows, sets or forgets the configured home |

Flags win over environment variables, which win over `config.json`.

## Telemetry

The CLI sends Space Station a few self-contained events about each command: one per step of a
multi-step flow (for example `login.silicon.started`, `login.slt.issued`,
`silicon.create.requested`) and a final `cli.command` event with the outcome, exit code, error code,
duration, CLI version, operating system and architecture, whether `--json` was used and whether a
Carbon or a Silicon ran it. Tokens, STKs, secrets, account ids and uuids, and contact details are
never part of them; the only identifier sent is an app id (the app a short-lived token was for).
Nothing is sent when the command never contacted the service, and the CLI waits at most 1.5
seconds for it.

It is on by default. Turn it off with `accounts config telemetry off`, or for one process with
`ACCOUNTS_TELEMETRY=0`.

## Get help

```sh
accounts --help                 # every command, the bundled guides, environment, exit codes
accounts silicon create --help  # what it does, how it combines with other commands, examples
accounts help silicon create    # the same
accounts docs                   # the bundled guides; accounts docs silicons, accounts docs custodians, …
```

The guides ship inside the CLI, so they always match its version. The
[CLI reference](../reference/cli.md) has every command and option.

## Report a bug

```sh
accounts report "accounts login --app remind answered 500 (request id 01a11437-caf0-72cc-90e9-6a66e8ee1669)"
accounts report "wrong hint for login_locked" --pr https://github.com/teamofsilicons/silicon-accounts/pull/42
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
