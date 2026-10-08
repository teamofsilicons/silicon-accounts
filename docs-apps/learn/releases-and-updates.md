---
title: Releases and automatic updates
description: Choose production or development releases, install a specific version and control how Apps updates your installed apps.
kind: informative
order: 40
related:
  - start/install.md
  - start/publish.md
  - reference/cli.md
  - reference/manifest.md
---

# Releases and automatic updates

## Choose a channel

Every new release starts in the development channel. When it is ready for general use, its authors can promote it to production. Promotion keeps the same packages and gives them a production version. Both channels use `x.y.z` versions, and each keeps its own version history.

| Install reference | Initial selection |
|---|---|
| `ring` | Latest production release |
| `ring>dev` | Latest development release |
| `ring@1.2.3` | Production version 1.2.3 |
| `ring>dev@0.1.0` | Development version 0.1.0 |

```sh
silicon-apps install 'ring>dev'
silicon-apps install 'ring@1.2.3'
silicon-apps install 'ring>dev@0.1.0'
silicon-apps update ring
```

Quote references containing `>` so your shell does not interpret them as redirection. An exact version selects the initial release; it is not a permanent pin. Later updates follow that channel's latest release.

Apps asks before switching an installed app to another channel or registry. If you are scripting an intentional switch, add `--yes`.

Each installed app remembers its registry. Changing the default server does not make existing apps get updates from that server. Use `--server URL update APP` with the original registry, or reinstall the app to choose a new source.

## The updater

Apps is the sole updater for installed apps, including Apps itself when registered as an installation. Other apps must not run their own updater. Installation starts the updater; bootstrap installation also configures its login service. The default interval is one minute.

```sh
silicon-apps daemon status
silicon-apps update
silicon-apps daemon install
silicon-apps daemon run --once
silicon-apps daemon stop
silicon-apps daemon start
silicon-apps daemon remove
```

`daemon install` registers launchd on macOS, a user systemd service on Linux, or Task Scheduler on Windows. `daemon remove` stops the updater and removes startup registration. `daemon definition` shows the generated service configuration. Use the same configured home for all these commands.

Only one updater can run for a given home at a time. Its status shows the latest run and any app that failed to update. If a registry does not match, you lose access to a private app, a package is missing or the network fails, the updater reports the problem. It does not choose another registry or target. Fix the reported problem, then retry.

On Windows, a helper replaces the running Apps executable. A message saying the update was scheduled does not mean it has finished. Check `.apps/self-update.log` for the final result.

## Installation and scripts

Before installing an update, Apps checks the package’s SHA-256 checksum and extracts it within the archive limits. It rejects unsafe paths and links, and checks that the new command will not overwrite another app’s command. It prepares the new installation before replacing the current one. If installation fails, it restores the previous package.

If a package includes an install script, Apps runs it automatically on your machine during installation and updates. The default timeout is 120 seconds. If the script fails or times out, Apps restores the previous package. Package rollback cannot undo a script's unrelated external side effects.

## Service-scoped sign-in

Saved access and refresh tokens belong to the complete Apps and Accounts URLs you signed in through, including any tenant path. If you change either service URL, sign in again. Apps will not send those saved tokens to the new service.

If you set `APPS_TOKEN` yourself, you are choosing which bearer token to send. Make sure it belongs to the service you are calling.

Older unscoped sessions require a fresh login. Unscoped installation records require an explicit reinstall with `--yes` before automatic updates resume.
