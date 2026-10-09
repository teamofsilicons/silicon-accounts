---
title: Releases and automatic updates
description: Choose production or development releases, install an exact version and see how Apps keeps your installed apps up to date.
kind: informative
order: 40
related:
  - start/install.md
  - start/publish.md
  - learn/signed-releases.md
  - reference/cli.md
  - reference/manifest.md
---

# Releases and automatic updates

## Choose a channel

Every new release starts in the development channel. When it's ready for everyone, its authors can promote it to production. Promotion keeps the same packages and gives them a production version. Both channels use `x.y.z` versions, and each keeps its own version history.

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

Quote any reference with `>` in it, so your shell doesn't read it as a redirect. An exact version picks the release you start on; it isn't a permanent pin. Later updates follow that channel's latest release.

Apps asks before it switches an installed app to another channel or registry. If your script is making that switch on purpose, add `--yes`.

Each installed app remembers its registry. Changing the default server doesn't make existing apps take their updates from that server. Use `--server URL update APP` with the original registry, or reinstall the app to pick a new source.

## The updater

Apps is the only updater for installed apps, including Apps itself when it's registered as an installation. Your app must not run an updater of its own, because a second one would only fight with ours. Installing an app starts the updater, and the bootstrap installers also set it up as a login service. By default it checks every minute.

```sh
silicon-apps daemon status
silicon-apps update
silicon-apps daemon install
silicon-apps daemon run --once
silicon-apps daemon stop
silicon-apps daemon start
silicon-apps daemon remove
```

`daemon install` registers the updater with launchd on macOS, as a user systemd service on Linux, or with Task Scheduler on Windows. `daemon remove` stops the updater and takes it out of startup. `daemon definition` shows the service configuration it generates. Use the same configured home for all of these commands.

Only one updater runs for a given home at a time. Its status shows the latest run and any app that failed to update. If a registry doesn't match, you lose access to a private app, a package is missing or the network fails, the updater reports the problem. It never picks another registry or target on its own. Fix what it reports, then retry.

On Windows, a helper replaces the running Apps executable. A message saying the update was scheduled doesn't mean it has finished, so check `.apps/self-update.log` for the final result.

## Installation and scripts

Before it installs an update, Apps checks the package's SHA-256 checksum and our Ed25519 signature over the release, plus the author's signature when there is one ([signed releases](signed-releases.md)). Then it extracts the package within the archive limits. It refuses unsafe paths and links, and checks that the new command won't overwrite another app's command. It prepares the new installation before it replaces the current one, and if installation fails, it puts the previous package back.

If a package includes an install script, Apps runs it automatically on your machine during installs and updates. The default timeout is 120 seconds. If the script fails or times out, Apps restores the previous package. Rolling back the package can't undo side effects the script had outside it.

The script's SHA-256 is part of the signed release, so you always know which script runs. Read it with `silicon-apps show APP --install-script`. When an update brings a different install script, `silicon-apps update` and `silicon-apps install` print one line with the old and new digests.

## Withdrawn releases

Authors can withdraw a release that turned out bad, and give a reason. From that moment:

- it's never served again, not even by exact version: `silicon-apps install 'ring@1.4.0'` fails with `release_withdrawn` and the reason;
- `silicon-apps install ring` gets the latest good release on that channel, even when its version is lower;
- every updater moves installed copies off it on its next check, reports `replaced_withdrawn` with the reason, and prints one line saying so.

It's still the one updater following the installed channel. A withdrawn release simply stops being part of that channel. The app page lists withdrawn releases with their reasons, and subscribers receive `release.withdrawn`.

## Service-scoped sign-in

Your saved access and refresh tokens belong to the exact Apps and Accounts URLs you signed in through, including any tenant path. If you change either service URL, sign in again. Apps won't send those saved tokens to the new service.

If you set `APPS_TOKEN` yourself, you're choosing which bearer token gets sent, so make sure it belongs to the service you're calling.

Older sessions that aren't scoped to a service need a fresh login. Installation records that aren't scoped need an explicit reinstall with `--yes` before automatic updates start again.
