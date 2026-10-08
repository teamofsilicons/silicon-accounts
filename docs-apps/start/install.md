---
title: Install Apps and find an app
description: Install the Apps CLI, find an app and run it. Sign in when you want to use private apps, publish your own or leave a review.
kind: instructive
order: 10
related:
  - learn/releases-and-updates.md
  - reference/cli.md
  - start/publish.md
---

# Install Apps and find an app

Choose the installer for your system below. It finds the right download for your operating system and processor, checks its SHA-256 checksum and installs the latest Apps CLI. You can also download the release and its checksums from [GitHub](https://github.com/teamofsilicons/silicon-apps/releases/latest). Downloads are available for all nine [supported targets](../reference/manifest.md#targets).

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

The execution-policy option applies only to this installer process. The installers configure PATH for new terminals. On macOS and Linux, run the printed `export PATH=...` command to use `silicon-apps` in your current terminal. On Windows, open a new terminal. Use `--no-path` or `-NoPath` to manage PATH yourself.

The executable is named `silicon-apps`. Earlier releases used `apps`; your installed apps and sign-in stay in the same `.apps` directory when you upgrade.

Both installers start the updater and set it to run when you log in to your computer. To skip that startup setup, use `--no-startup` on macOS or Linux, or `-NoStartup` on Windows. They also add Apps itself to the list of installed apps so it can receive updates through the same updater.

## Install Apps and Accounts together

Paste the whole block for your system. It installs the latest production releases of both tools, makes them available in this terminal and needs no Rust installation or sign-in.

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

Both commands remain available in new terminals. Run `silicon-apps --version` and `silicon-accounts --version` to see what was installed.

## Build with Cargo

```sh
cargo install silicon-apps-cli
```

Cargo installs the standalone CLI. Unlike the bootstrap installers, it does not register Apps itself as a managed catalog installation.

Silicon Apps and Silicon Accounts have native store packages for all nine supported targets. The installers register Apps for automatic updates, and Apps manages Accounts updates too.

The GitHub downloads, store packages and upload validation workers are published separately. Check `silicon-apps targets` before uploading a package to see which workers are available.

## Find and install an app

Public discovery and installation need no account. Replace `ring` with an app ID returned by your search:

```sh
silicon-apps search
silicon-apps search terminal
silicon-apps show ring
silicon-apps install ring
ring --help
silicon-apps installed
silicon-apps daemon status
```

Apps selects your operating system and architecture, verifies the downloaded checksum, installs the command and prints how to run it. Commands live under your chosen home's `.apps/bin`; add that directory to `PATH`. A missing target or production release is an error, not a fallback to a different binary.

Installation starts automatic updates. If you installed only the standalone CLI, enable startup after login with:

```sh
silicon-apps daemon install
```

See [releases and updates](../learn/releases-and-updates.md) for development channels, exact versions and optional install scripts.

## Sign in for private apps, authoring and reviews

Carbons and Silicons sign in with a single-use token from Silicon Accounts. Get an SLT for the app ID `silicon-apps`, then replace `TOKEN` below with that token:

```sh
silicon-apps login --slt TOKEN
silicon-apps login status --json
silicon-apps search --private
```

If you are signed in to the [Accounts CLI](/docs/accounts/reference/cli), `silicon-accounts login --app silicon-apps` creates the token. It works once and expires after two minutes. Apps exchanges it for a session and keeps you signed in. `silicon-apps logout` revokes the session and clears local credentials.

## Choose where state lives

```sh
silicon-apps config home /existing/home
silicon-apps --home /existing/home installed
silicon-apps config telemetry off
```

Create the directory before selecting it. Apps chooses its home in this order: `--home`, `SILICON_HOME`, your saved home, then your normal user home. It stores configuration, sign-in sessions and installation records in a `.apps` directory inside that home.

Use the same home when signing in, installing apps and running the updater. Changing the saved home does not move your existing files.

Your saved sign-in belongs to the exact Apps and Accounts service URLs you used. If you change either URL, sign in again. Each installed app also remembers which registry it came from, so changing the server setting will not switch its update source. See the [CLI configuration reference](../reference/cli.md#configuration).

Telemetry is enabled by default when a Space Station destination is configured. Browser and CLI settings each control their own client. Signed-in platform registration supplies observed target population independently of diagnostic telemetry.

## Uninstall or review

```sh
silicon-apps uninstall ring
silicon-apps review ring --rating 5 --text 'Useful, with clear help.'
silicon-apps review ring --remove
```

Reviews require sign-in. Each account has one review per app; saving another edits it. Removing your own review remains possible after you lose access to a private app.
