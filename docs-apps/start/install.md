---
title: Install Apps and find an app
description: Install the Apps CLI, choose a local home, sign in when needed, and install or review a catalog app.
kind: instructive
order: 10
related:
  - learn/releases-and-updates.md
  - reference/cli.md
  - start/publish.md
---

# Install Apps and find an app

Download the installer for your system, review it, then run it. It selects your platform and checks the release archive's SHA-256 before installing Apps CLI 0.1.4. [Downloads, checksums and native command evidence](https://github.com/teamofsilicons/silicon-apps/releases/tag/v0.1.4) are available for all nine [supported targets](../reference/manifest.md#targets).

## macOS and Linux

```sh
curl -fsSL https://apps.teamofsilicons.com/install.sh -o install-apps.sh
bash install-apps.sh --version 0.1.4 --server https://apps.teamofsilicons.com
```

## Windows PowerShell

```powershell
Invoke-WebRequest -Uri https://apps.teamofsilicons.com/install.ps1 -OutFile install-apps.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-apps.ps1 -Version 0.1.4 -Server https://apps.teamofsilicons.com
```

The execution-policy option applies only to this installer process. Add the directory printed by the installer to `PATH` before using `apps`.

Both installers start the updater and register it to run after login. Use `--no-startup` on macOS/Linux or `-NoStartup` on Windows to skip startup registration. Installers also register Apps itself in the installation state so it can use the same update mechanism.

## Build with Cargo

```sh
cargo install silicon-apps-cli --version 0.1.4 --locked
```

Cargo installs the standalone CLI. Unlike the bootstrap installers, it does not register Apps itself as a managed catalog installation.

The Apps catalog release for Apps itself currently has a Linux x64 package. On other platforms, use the GitHub installers above: `apps install apps` cannot yet find a matching catalog package, and the installed CLI cannot receive catalog updates until a package for its target is published. Nine GitHub downloads do not mean nine hosted validation workers or catalog packages.

## Find and install an app

Public discovery and installation need no account. Replace `ring` with an app ID returned by your search:

```sh
apps search
apps search terminal
apps show ring
apps install ring
ring --help
apps installed
apps daemon status
```

Apps selects your operating system and architecture, verifies the downloaded checksum, installs the command and prints how to run it. Commands live under your chosen home's `.apps/bin`; add that directory to `PATH`. A missing target or production release is an error, not a fallback to a different binary.

Installation starts automatic updates. If you installed only the standalone CLI, enable startup after login with:

```sh
apps daemon install
```

See [releases and updates](../learn/releases-and-updates.md) for development channels, exact versions and optional install scripts.

## Sign in for private apps, authoring and reviews

```sh
apps login
apps login status --json
apps search --private
```

`apps login` uses Silicon Accounts device sign-in: approve the code in your browser. The official Accounts client obtains a single-use Apps token and exchanges it through the Apps backend. No app secret ships in the CLI.

For a Silicon, put its STK in the `SILICON_STK` environment variable and run:

```sh
apps login --silicon si:assistant
```

`--stk-env NAME` selects another environment variable. `apps login --slt TOKEN` accepts an Accounts-issued one-use Apps token. Treat the token as a credential; avoid saving it in shell history. `apps logout` revokes the session and clears local credentials.

## Choose where state lives

```sh
apps config home /existing/home
apps --home /existing/home installed
apps config telemetry off
```

The directory must already exist. Home selection is `--home`, then `SILICON_HOME`, then the saved home, then the normal user home. Configuration, sessions and installed records live inside that home's `.apps` directory. Use the same home for sign-in, installation and the updater. Saving a home does not migrate files.

Sessions are bound to the complete Apps and Accounts service URLs. Changing either requires a fresh sign-in. Installed apps also retain their registry URL; another registry cannot silently replace them. See the [CLI configuration reference](../reference/cli.md#configuration).

Telemetry is enabled by default when a Space Station destination is configured. Browser and CLI settings each control their own client. Signed-in platform registration supplies observed target population independently of diagnostic telemetry.

## Uninstall or review

```sh
apps uninstall ring
apps review ring --rating 5 --text 'Useful, with clear help.'
apps review ring --remove
```

Reviews require sign-in. Each account has one review per app; saving another edits it. Removing your own review remains possible after you lose access to a private app.
