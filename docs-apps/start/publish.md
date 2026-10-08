---
title: Publish an app
description: Create an app, save its publishing setup, package a native CLI, upload it for validation and publish a release.
kind: instructive
order: 20
related:
  - reference/manifest.md
  - start/share.md
  - learn/releases-and-updates.md
  - reference/api.md
---

# Publish an app

This guide uses `ring` as an example. Choose your own available ID and replace it throughout. You can perform the same publishing steps in the [developer portal](https://developers.teamofsilicons.com); saved drafts show **Continue setup** and resume where you left off.

## Create the app

```sh
apps login
apps availability ring
apps create ring --name Ring
```

Save the `app_secret` now: it is shown once. New IDs contain 3–30 lowercase letters, digits, hyphens or underscores and cannot change. Existing migrated Accounts IDs such as `dm` remain usable. Creating the app also makes it available for [Accounts sign-in configuration](/docs/accounts/start/add-sign-in).

If a mutation has an uncertain network outcome, retry with its same idempotency key. The CLI includes generated mutation keys in failure context; you can supply `--idempotency-key KEY` yourself. Do not create a new operation merely to recover a one-time secret. [API retry rules](../reference/api.md#authentication-and-retries) explain the limited secret replay window.

## Save details and access

Write a 200–600 character introduction in `description.txt`, then save it:

```sh
apps setup ring details --description-file description.txt --tags tools,productivity
apps setup ring access --visibility public
apps setup ring show
```

Drafts may be incomplete. Publication needs the description and at least one accepted package in a release. You can use up to 20 tags. Only the app's administrator changes public/private access. [Private sharing and authorship](share.md) are different permissions.

The setup steps are Details, Access, Packages, Links, Media, Updates from Silicon Accounts, and Review and publish. Details, Access and Packages are required. Move between steps freely; `apps setup ring step 3` saves your resume position.

## Implement the three discovery commands

Every target executable must support:

```sh
ring --help
ring accounts --json
ring login status --json
```

Help must exit successfully with useful text. Accounts must exit successfully with JSON containing `{"app_id":"ring"}`. In a clean signed-out environment, login status must return `{"authenticated":false}`. When signed in, it reports `authenticated: true` and the Carbon or Silicon identity. These commands let Silicons find instructions and determine which account an app is using.

## Validate and pack

Put your native executable at `package/bin/ring` and create `package/apps.yaml`:

```yaml
schema_version: 1
app_id: ring
version: 0.1.0
command: ring
targets:
  linux-x86_64:
    binary: bin/ring
```

This example targets Linux x64. Use the target and native binary you actually built. `apps targets` lists all nine target names and current runner availability; an unavailable worker cannot validate an upload.

```sh
apps validate ./package
apps pack ./package --output ./ring.tar.gz
```

Validate reports structural errors together. Pack creates a deterministic gzip archive; put its output outside the source directory. See the [manifest reference](../reference/manifest.md) for multiple targets, optional scripts and archive rules.

## Upload, release and promote

```sh
apps upload ring --target linux-x86_64 ./ring.tar.gz
apps packages ring
apps release ring --version 0.1.0 --package PACKAGE_ID
apps promote ring DEVELOPMENT_RELEASE_ID --version 1.0.0
```

Copy the accepted package ID into the release command, then its development release ID into the promotion command. Repeat `--package PACKAGE_ID` when a release has multiple targets. All targets are optional, but a release needs at least one.

Upload runs the three commands in an isolated runner for that target. Failure includes command output, expected results and the reason. Local structural validation is not proof that runtime checks passed. Packages are never executed on the API host.

New releases are development releases. Promotion creates a production release using the same accepted bytes, with an independent production `x.y.z` version. A production release is needed for the default `apps install ring` command. Versions and releases are immutable; upload new packages for your next release.

## Add optional links, media and webhooks

```sh
apps setup ring links links.json
apps setup ring media media.json
```

Example `links.json`:

```json
{"website":"https://example.com","developer_docs":"https://example.com/docs","android":"","ios":"","custom":[{"label":"Source","url":"https://github.com/example/ring","logo":""}]}
```

Use at most four custom links. Media can include `logo`, `logo_alt`, `banner`, `banner_alt` and up to 20 `carousel` images or videos, each with `url`, `kind` and `alt`. Alt text supports up to 10,000 characters for accessible descriptions. The portal can upload media; the API returns a URL to save in these fields. See the [API](../reference/api.md) for formats and limits.

For account changes, [configure Accounts webhooks](share.md#account-update-webhooks). Save each generated secret when it is shown.

## Publish

```sh
apps readiness ring
apps publish ring
```

Readiness lists every missing requirement. Publish makes the app live immediately for its permitted audience; there is no manual publication review. It is possible to publish with development releases only, but a default production install then has no release to select.

App details and access carry over to later releases. Inspect changes with `apps history ring`, or continue with [sharing](share.md) and [updates](../learn/releases-and-updates.md).
