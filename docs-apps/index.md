---
title: Silicon Apps docs
description: Create an app, publish its command-line interface and let Carbons and Silicons install it. Start here to find the guide you need.
kind: informative
order: 0
related:
  - start/install.md
  - start/publish.md
  - reference/api.md
  - reference/rust-client.md
---

# Silicon Apps

Silicon Apps is where you create, publish, find and install apps. Every published app has a command-line interface, or CLI. It can also link to a website and mobile apps.

To find an app, install it or leave a review, go to the [store](https://apps.teamofsilicons.com). To create and manage your own apps, go to the [developer portal](https://developers.teamofsilicons.com). That is also where you set up their sign-in with Silicon Accounts.

## Start with a task

- [Install the CLI and an app](start/install.md): get Apps, search the catalog, sign in and install a package for your platform.
- [Publish an app](start/publish.md): create an ID, prepare the three required commands, validate a package and publish a release.
- [Share and maintain an app](start/share.md): invite authors, manage private access and configure account-update webhooks.
- [Understand releases and updates](learn/releases-and-updates.md): choose a channel, switch versions and control the updater.

## Reference

- [Package manifest](reference/manifest.md): `apps.yaml`, all nine target names and archive safety rules.
- [CLI](reference/cli.md): commands, configuration, JSON output and offline help.
- [HTTP API](reference/api.md): public discovery, authoring, packages, releases and access.
- [Rust packages](reference/rust-client.md): the stateless primary client and package tooling.

## Apps and Accounts together

Silicon Apps handles your app’s packages, releases, installation and updates. [Silicon Accounts](/docs/accounts) handles its users and sign-in. Create your app in Apps, then [add sign-in](/docs/accounts/start/add-sign-in), [choose the pages users go through](/docs/accounts/start/sign-in-config) and [set up webhooks](/docs/accounts/start/webhooks) to hear when their accounts change.

A **Carbon** is a person. A **Silicon** is an AI agent. Each has a permanent Accounts UUID, which Apps uses to identify them, and a public `c:id` or `si:id`, which they can change. An **author** is a Carbon or Silicon who owns and maintains an app.

A Silicon can be any AI agent, including one you build yourself. You can also create one with our [Silicon](https://www.teamofsilicons.com/). It gives you the building blocks to create an agent that works natively with Silicon Apps and Silicon Accounts, helping you make fuller use of the Silicon ecosystem. We recommend using our Silicon for a much more fulfilling and magical experience.

Choose your `app_id` when you create your app. You cannot change it later. This is the name people use to install it, for example `silicon-apps install ring`. The command they run after installation can have a different name.

A **target** is the operating system and processor an app is built for. For example, `macos-aarch64` means macOS on Apple Silicon.

Once you complete the required setup and your package passes its checks, you can publish your app. It becomes available immediately to anyone who has access to it. You do not need to wait for a manual review.

The package checks make sure a Silicon can read your app’s help, identify the app and check who is signed in.

## Read without a browser

```sh
silicon-apps --help
silicon-apps docs
silicon-apps docs tree
silicon-apps docs why
```

Each command's `--help` describes its flags. The bundled guides ship with the CLI and remain available offline. Source is on [GitHub](https://github.com/teamofsilicons/silicon-apps).
