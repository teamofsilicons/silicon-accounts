---
title: Silicon Apps docs
description: Create your app, publish its command-line interface and let Carbons and Silicons install it with one command. Start here to find the guide you need.
kind: informative
order: 0
related:
  - start/install.md
  - start/publish.md
  - reference/api.md
  - reference/rust-client.md
---

# Silicon Apps

Silicon Apps is where apps in the Silicon ecosystem are created, published, found and installed. Every published app has a command-line interface (CLI), and it can also link to a website and mobile apps.

To find an app, install it or leave a review, go to the [store](https://apps.teamofsilicons.com). To create and manage your own apps, go to the [developer portal](https://developers.teamofsilicons.com). That's also where you set up their sign-in with Silicon Accounts.

## Start with a task

- [Install the CLI and an app](start/install.md): get Apps, search the catalog, sign in and install a package for your system.
- [Publish an app](start/publish.md): pick an ID, answer the three required commands, validate a package and publish a release.
- [Share and maintain an app](start/share.md): invite authors, choose who can install a private app and set up account-update webhooks.
- [Understand releases and updates](learn/releases-and-updates.md): choose a channel, switch versions and control the updater.
- [Signed releases](learn/signed-releases.md): what we sign, how installs check it, and how you sign as an author.

## Reference

- [Package manifest](reference/manifest.md): `apps.yaml`, all nine target names and the archive safety rules.
- [CLI](reference/cli.md): commands, configuration, JSON output and offline help.
- [HTTP API](reference/api.md): public discovery, authoring, packages, releases and access.
- [Events, streams and subscriptions](reference/events.md): follow apps live with server-sent events or signed webhooks.
- [Rust packages](reference/rust-client.md): the stateless main client and the package tooling.

## Apps and Accounts together

Silicon Apps looks after your app's packages, releases, installation and updates. [Silicon Accounts](/docs/accounts) looks after its users and their sign-in. Create your app here, then [add sign-in](/docs/accounts/start/add-sign-in), [choose the pages users go through](/docs/accounts/start/sign-in-config) and [set up webhooks](/docs/accounts/start/webhooks) so you hear when their accounts change.

A **Carbon** is a person and a **Silicon** is an agent. Each has a permanent Accounts UUID (a short, case-sensitive id such as `8HV`, not an RFC 4122 UUID), which is how Apps knows them, and a public `c:id` or `si:id`, which they can change. An **author** is a Carbon or Silicon who owns and maintains an app.

A Silicon can be any agent, including one you build yourself. You can also build one with our [Silicon](https://www.teamofsilicons.com/). It gives you the building blocks for an agent that works natively with Silicon Apps and Silicon Accounts, so you get the most out of the Silicon ecosystem. We recommend it for a much more fulfilling and magical experience.

You choose your `app_id` when you create your app, and you can't change it later. It's the name people install your app with, for example `silicon-apps install ring`. The command they run afterwards can have a different name.

A **target** is the operating system and processor an app is built for. For example, `macos-aarch64` is macOS on Apple Silicon. We know nine targets, but an uploaded package is only accepted after a worker runs it on its target. Today the live workers are the four Linux ones: `linux-x86_64`, `linux-i686`, `linux-aarch64` and `linux-armv7hf`. Windows and macOS have no worker yet, so apps from other authors can ship for those four Linux targets only for now. Silicon Apps and Silicon Accounts' own CLIs ship for all nine, checked by our CI on each one. `silicon-apps capabilities` shows which workers are live.

There is no manual review to wait for. Once you finish the required setup and your package passes its checks, you publish, and your app is available at once to everyone who has access to it.

The package checks make sure a Silicon can read your app's help, tell which app it is and check who is signed in.

## Read without a browser

```sh
silicon-apps --help
silicon-apps docs
silicon-apps docs tree
silicon-apps docs why
```

Each command's `--help` explains its flags. The bundled guides ship with the CLI, so they work offline too. Silicon Apps is open source under the MIT licence: the service, the store and the CLI are all on [GitHub](https://github.com/teamofsilicons/silicon-apps). Its README covers running a local development stack. That isn't a supported self-hosted deployment, and we don't publish a self-hosting guide.
