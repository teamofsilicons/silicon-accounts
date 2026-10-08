# Getting started with the silicon-accounts CLI

Silicon Accounts gives every Carbon and every Silicon one personal account that it
carries into every app it signs into. This CLI is how you use that account from a
terminal. It is built only on the `silicon-accounts-client` Rust package, so anything
you can do here you can also do from Rust, and the other way round.

## 1. Sign in

Pick the line that matches you:

```sh
# A Carbon, with a browser: prints a code, opens accounts.teamofsilicons.com/device
silicon-accounts login

# A Carbon, without a browser: a 6-digit code goes to your email (or --phone)
silicon-accounts login --email you@example.com
# …non-interactive? finish it with a second call:
silicon-accounts login --email you@example.com --code 123456

# A Silicon: your si:id and STK (read from stdin so it never shows in `ps`)
printf '%s' "$STK" | silicon-accounts login --silicon si:scout --stk-stdin
```

Silicons can also export `ACCOUNTS_SILICON=si:scout` and `ACCOUNTS_STK=stk-…` and run
`silicon-accounts login`.

Why these choices: a Carbon proves who they are with something they hold (a browser
session, an inbox, a phone). A Silicon has no inbox; its STK is its password, set once
and rotated by its custodian.

## 2. Check who you are

```sh
silicon-accounts login status --json
# {"authenticated":true,"kind":"silicon","id":"si:scout","uuid":"b9Z","expires_at":"…"}
silicon-accounts whoami
```

`login status` exits 0 when signed in and 1 when not, so scripts can branch on it.
The session lives in `{home}/.accounts/session.json` (mode 0600). Access tokens last
30 minutes and are refreshed automatically; the refresh token lasts up to 900 days.

## 3. Sign into an app

```sh
silicon-accounts login --app remind
```

prints a short-lived token (`slt_…`, single use, 2 minutes). Hand it to the app; the
app exchanges it for your tokens. This is how Silicons sign into apps: they never go
through an app's sign-in page. If you are already signed in, the token comes back
directly.

## 4. Everything else

```sh
silicon-accounts --help                 # the whole command tree
silicon-accounts <command> --help       # what it does, how it combines with others, examples
silicon-accounts docs                   # these guides
```

Useful next stops: `silicon-accounts docs silicons` (getting a Silicon an account),
`silicon-accounts docs apps` (adding sign-in to an app), `silicon-accounts docs troubleshooting`.

## Where the CLI keeps things

State goes in `{home}/.accounts/`. The home is `--home`, else `ACCOUNTS_HOME`, else the
directory set with `silicon-accounts config home <dir>`, else `$SILICON_HOME`, else `~`.
`silicon-accounts config get` shows every setting and where it came from. Use `--url` (or
`ACCOUNTS_URL`, or `silicon-accounts config set url …`) to talk to another Silicon Accounts
instance, e.g. a local one at `http://localhost:8590` (the account site, which forwards the API;
`http://127.0.0.1:8589` reaches accounts-api directly).

## Output, errors and exit codes

* `--json` prints machine-readable output on stdout, errors included
  (`{"error":{"code","message","hint"}}`).
* Text mode (the default) prints the result on stdout and progress, notices and next-step
  suggestions on stderr; `-q` silences the extras.
* Exit codes: 0 ok, 1 failure, 2 invalid input (or an invalid proof/token being
  checked), 3 sign-in required or refused, 4 not found, 5 conflict, 6 rate limited or
  locked. See `silicon-accounts docs troubleshooting`.

Telemetry (command, outcome, timing; never tokens, ids or contact details) is on by
default; turn it off with `silicon-accounts config telemetry off` or `ACCOUNTS_TELEMETRY=0`.
Updates are handled by Silicon Apps; the CLI never updates itself.
