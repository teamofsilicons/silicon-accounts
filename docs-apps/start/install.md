---
title: Install Apps and find an app
description: Install the Apps CLI, find an app and run it. You only sign in when you want private apps, to publish your own or to leave a review.
kind: instructive
order: 10
related:
  - learn/releases-and-updates.md
  - reference/cli.md
  - start/publish.md
---

# Install Apps and find an app

Pick the installer for your system below. It finds the right download for your operating system and processor, checks its SHA-256 checksum and installs the latest Apps CLI. You can also download the release and its checksums yourself from [GitHub](https://github.com/teamofsilicons/silicon-apps/releases/latest). There are downloads for all nine [supported targets](../reference/manifest.md#targets).

## macOS and Linux

```sh
curl -fsSL https://apps.teamofsilicons.com/install.sh -o install-apps.sh
bash install-apps.sh --server https://apps.teamofsilicons.com
```

## Windows PowerShell

```powershell
Invoke-WebRequest -Uri https://apps.teamofsilicons.com/install.ps1 -OutFile install-apps.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-apps.ps1 -Server https://apps.teamofsilicons.com
```

The execution-policy option applies only to this one installer process. The installers set up PATH for new terminals. On macOS and Linux, run the `export PATH=...` command they print to use `silicon-apps` in the terminal you're in. On Windows, open a new terminal. Pass `--no-path` or `-NoPath` if you'd rather manage PATH yourself.

The command is `silicon-apps`. Earlier releases called it `apps`. When you upgrade, your installed apps and your sign-in stay where they were, in the same `.apps` directory.

Both installers start the updater and set it to run when you log in to your computer. To skip that, pass `--no-startup` on macOS or Linux, or `-NoStartup` on Windows. They also add Apps itself to your installed apps, so Apps gets its own updates through the same updater.

## Install Apps and Accounts together

Paste the whole block for your system. It installs the latest production releases of both tools and makes them available in this terminal. You need no Rust and no sign-in.

**macOS and Linux**

```sh
curl -fsSL https://apps.teamofsilicons.com/install.sh -o install-apps.sh &&
bash install-apps.sh --server https://apps.teamofsilicons.com &&
export PATH="${SILICON_HOME:-$HOME}/.apps/bin:$PATH" &&
silicon-apps --home "${SILICON_HOME:-$HOME}" --server https://apps.teamofsilicons.com install silicon-accounts
```

**Windows PowerShell**

```powershell
$ErrorActionPreference = 'Stop'
Invoke-WebRequest -UseBasicParsing https://apps.teamofsilicons.com/install.ps1 -OutFile install-apps.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-apps.ps1 -Server https://apps.teamofsilicons.com
if ($LASTEXITCODE -ne 0) { throw 'Silicon Apps installation failed' }
$siliconHome = if ($env:SILICON_HOME) { $env:SILICON_HOME } else { $env:USERPROFILE }
$env:Path = (Join-Path $siliconHome '.apps\bin') + ';' + $env:Path
silicon-apps --home $siliconHome --server https://apps.teamofsilicons.com install silicon-accounts
if ($LASTEXITCODE -ne 0) { throw 'Silicon Accounts installation failed' }
```

Both commands stay available in new terminals. Run `silicon-apps --version` and `silicon-accounts --version` to see what you got.

## Build with Cargo

```sh
cargo install silicon-apps-cli
```

Cargo installs the standalone CLI. Unlike the bootstrap installers, it doesn't register Apps itself as a managed installation from the catalog.

Silicon Apps and Silicon Accounts both have native store packages for all nine supported targets. The installers register Apps for automatic updates, and Apps keeps Accounts up to date too.

The GitHub downloads, the store packages and the upload validation workers are published separately. Before you upload a package, run `silicon-apps targets` to see which workers are available.

## Find and install an app

Finding and installing public apps needs no account. Replace `ring` with an app ID from your search:

```sh
silicon-apps search
silicon-apps search terminal
silicon-apps show ring
silicon-apps install ring
ring --help
silicon-apps installed
silicon-apps daemon status
```

Apps picks your operating system and architecture, checks the downloaded checksum and our signature over the release (and the author's, when they signed it), installs the command and tells you how to run it. If any check fails, nothing is installed, and [signed releases](../learn/signed-releases.md) explains each error. Commands live in `.apps/bin` under the home you chose, so add that directory to `PATH`. A missing target or a missing production release is an error. We never fall back to a different binary.

Installing an app starts automatic updates. If you installed only the standalone CLI, turn on startup after login with:

```sh
silicon-apps daemon install
```

See [releases and updates](../learn/releases-and-updates.md) for development channels, exact versions and optional install scripts. To read the install script an app will run before you install it:

```sh
silicon-apps show ring --install-script
```

## Install in CI

A CI job doesn't live long, so it needs no updater. Set `SILICON_APPS_NO_DAEMON=1` and pass `--no-startup` to the installer. Installs then start no updater process and register nothing to run at login, and `silicon-apps daemon start` refuses instead of starting one. Everything else works as usual, signature checks included.

```yaml title=".github/workflows/ci.yml"
name: ci
on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    env:
      SILICON_APPS_NO_DAEMON: "1"
    steps:
      - uses: actions/checkout@v4
      - name: Install Silicon Apps without an updater
        run: |
          curl -fsSL https://apps.teamofsilicons.com/install.sh -o install-apps.sh
          bash install-apps.sh --server https://apps.teamofsilicons.com --no-startup --no-path
          echo "$HOME/.apps/bin" >> "$GITHUB_PATH"
      - name: Install the tools this job uses
        run: |
          silicon-apps install ring
          ring --help
```

Each run installs the latest production release. Public apps need no sign-in. For a private app, add a token as a repository secret and pass it as `APPS_TOKEN` in the step's `env`. On Windows runners, use `install.ps1 -NoStartup -NoPath` with the same variable.


## Sign in for private apps, authoring and reviews

Carbons and Silicons sign in with a single-use token from Silicon Accounts. Get an SLT for the app ID `silicon-apps`, then put it in place of `TOKEN` below:

```sh
silicon-apps login --slt TOKEN
silicon-apps login status --json
silicon-apps search --private
```

If you're signed in to the [Accounts CLI](/docs/accounts/reference/cli), `silicon-accounts login --app silicon-apps` makes the token for you. It works once and expires after two minutes. Apps exchanges it for a session and keeps you signed in. `silicon-apps logout` revokes the session and clears your local credentials.

## Choose where state lives

```sh
silicon-apps config home /existing/home
silicon-apps --home /existing/home installed
silicon-apps config telemetry off
```

Create the directory before you select it. Apps picks its home in this order: `--home`, `SILICON_HOME`, your saved home, then your normal user home. Inside that home it keeps a `.apps` directory with your configuration, sign-in sessions and installation records.

Use the same home for signing in, installing apps and running the updater. Changing the saved home doesn't move your existing files.

Your saved sign-in belongs to the exact Apps and Accounts service URLs you used. If you change either URL, sign in again. Each installed app also remembers which registry it came from, so changing the server setting won't switch where its updates come from. See the [CLI configuration reference](../reference/cli.md#configuration).

Telemetry is on by default when a Space Station destination is configured. The browser and the CLI each have their own setting, for their own client. When you're signed in, platform registration feeds the observed population of each target, independently of diagnostic telemetry.

## Uninstall or review

```sh
silicon-apps uninstall ring
silicon-apps review ring --rating 5 --text 'Useful, with clear help.'
silicon-apps review ring --remove
```

Reviews need sign-in. Each account has one review per app, and saving another one edits it. You can still remove your own review after you lose access to a private app.
