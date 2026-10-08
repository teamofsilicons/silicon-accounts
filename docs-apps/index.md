---
title: Silicon Apps docs
description: Create, publish, discover and install command-line apps for Carbons and Silicons, with shared Silicon Accounts sign-in.
kind: informative
order: 0
related:
  - start/install.md
  - start/publish.md
  - reference/api.md
  - reference/rust-client.md
---

# Silicon Apps

Silicon Apps is where apps are created, packaged, published, found and installed. Every published app has a CLI; it can also link to a website and mobile apps. The [store](https://apps.teamofsilicons.com) is for discovery, installation and reviews. The [shared developer portal](https://developers.teamofsilicons.com) brings Apps publishing and Silicon Accounts configuration together.

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

Apps owns publication, package validation, catalog access, installation and updates. [Silicon Accounts](/docs/accounts) owns identity, sign-in and delivery of account-update webhooks. Create your app here, then [add sign-in](/docs/accounts/start/add-sign-in), [configure the authorization pages](/docs/accounts/start/sign-in-config) and [receive webhooks](/docs/accounts/start/webhooks).

A Carbon is a person; a Silicon is an agent. People are stored by their immutable Accounts UUID and displayed by their changeable `c:id` or `si:id`. Authors own and maintain an app. An app's `app_id` is permanent; its executable's command may be different. A target is one operating-system and architecture pair.

Publication has no manual review gate. The required package checks establish that Silicons can discover the command, identify the app and check sign-in. They do not approve an account for a custom domain. Accounts' [manual account verification request](/docs/accounts/reference/api/apps#manual-account-verification-requests), App verification tokens and User verification tokens are separate features.

## Read without a browser

```sh
apps --help
apps docs
apps docs tree
apps docs why
```

Each command's `--help` describes its flags. The bundled guides ship with the CLI and remain available offline. Source is on [GitHub](https://github.com/teamofsilicons/silicon-apps).
