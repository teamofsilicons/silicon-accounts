---
title: Releases and automatic updates
description: How production and development channels, exact versions, registry sources and the sole updater work.
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

Production and development have independent `x.y.z` versions. New releases enter development; promotion creates an immutable production release using the same package bytes.

| Install reference | Initial selection |
|---|---|
| `ring` | Latest production release |
| `ring>dev` | Latest development release |
| `ring@1.2.3` | Production version 1.2.3 |
| `ring>dev@0.1.0` | Development version 0.1.0 |

```sh
apps install 'ring>dev'
apps install 'ring@1.2.3'
apps install 'ring>dev@0.1.0'
apps update ring
```

Quote references containing `>` so your shell does not interpret them as redirection. An exact version selects the initial release; it is not a permanent pin. Later updates follow that channel's latest release.

The CLI asks before changing an installed app's channel or registry. `--yes` confirms an intentional noninteractive switch. Saved installation records retain their registry; changing the global server cannot silently replace an app with the same ID from another service. Use the matching `--server URL update APP`, or explicitly reinstall to change sources.

## The updater

Apps is the sole updater for installed apps, including Apps itself when registered as an installation. Other apps must not run their own updater. Installation starts the updater; bootstrap installation also configures its login service. The default interval is one minute.

```sh
apps daemon status
apps update
apps daemon install
apps daemon run --once
apps daemon stop
apps daemon start
apps daemon remove
```

`daemon install` registers launchd on macOS, a user systemd service on Linux, or Task Scheduler on Windows. `daemon remove` stops the updater and removes startup registration. `daemon definition` shows the generated service configuration. Use the same configured home for all these commands.

Only one updater holds the home lock. Status includes the latest run and per-app failures. Registry mismatch, lost private access, unavailable packages or network errors do not authorize a different source or target. Fix the reported problem and retry. On Windows, self-update uses a helper so the running executable can be replaced; the scheduled receipt is not the final result, which is recorded in `.apps/self-update.log`.

## Installation and scripts

Apps verifies the selected package's SHA-256 before bounded extraction. It rejects unsafe paths and links, checks command ownership, then stages and atomically replaces the installation. A failure restores the previous package.

Optional install scripts run locally only after explicit consent:

```sh
apps install ring --allow-install-script
```

Review the script first. Consent is recorded for that app's subsequent updates. The default timeout is 120 seconds. Package rollback cannot undo a script's unrelated external side effects.

## Service-scoped sign-in

Access and refresh tokens are bound to the complete Apps and Accounts URLs, including tenant paths. Changing either service requires a new login; saved credentials are never silently forwarded to the new service. `APPS_TOKEN` is an explicitly supplied externally managed bearer token and remains the caller's responsibility.

Older unscoped sessions require a fresh login. Unscoped installation records require an explicit reinstall with `--yes` before automatic updates resume.
