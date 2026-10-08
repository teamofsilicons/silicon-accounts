---
title: Publish an app
description: Create your app, prepare a package, check it and publish a release. Follow the steps with the Apps CLI or the developer portal.
kind: instructive
order: 20
related:
  - reference/manifest.md
  - start/share.md
  - learn/releases-and-updates.md
  - reference/api.md
---

# Publish an app

We will publish an app called `ring`. Choose an available app ID of your own and use it wherever you see `ring` below.

You can also follow these steps in the [developer portal](https://developers.teamofsilicons.com). Your setup is saved as you go. If you leave before publishing, choose **Continue setup** to pick up where you stopped.

## Create the app

```sh
apps login
apps availability ring
apps create ring --name Ring
```

Save the `app_secret` when it appears. You will only see it once.

Your new app ID must contain 3 to 30 lowercase letters, digits, hyphens or underscores. You cannot change it after creating the app. Older Accounts IDs such as `dm` still work. As soon as you create the app, you can [set up its sign-in](/docs/accounts/start/add-sign-in).

If the connection fails before you get a response, the server may already have made the change. Retry with the same idempotency key so it can return the original result instead of doing the work twice. The CLI includes that key in the error details, or you can set it yourself with `--idempotency-key KEY`.

Keep the same key when recovering a response that contained a secret. Starting a new request will not recover the old secret. The [API retry rules](../reference/api.md#authentication-and-retries) explain how long that response can be recovered.

## Save details and access

Write a 200–600 character introduction in `description.txt`, then save it:

```sh
apps setup ring details --description-file description.txt --tags tools,productivity
apps setup ring access --visibility public
apps setup ring show
```

You can save a draft before everything is ready. To publish, you need the description and at least one package that has passed validation and belongs to a release. You can add up to 20 tags.

Only the app’s administrator can switch it between public and private. [Sharing an app and inviting an author](share.md) give people different kinds of access.

The setup steps are Details, Access, Packages, Links, Media, Updates from Silicon Accounts, and Review and publish. Details, Access and Packages are required. Move between steps freely; `apps setup ring step 3` saves your resume position.

## Implement the three discovery commands

Every target executable must support:

```sh
ring --help
ring accounts --json
ring login status --json
```

Each command has a specific job:

- `ring --help` must exit successfully and explain how to use the app.
- `ring accounts --json` must exit successfully and return JSON containing `{"app_id":"ring"}`.
- `ring login status --json` must return `{"authenticated":false}` when no one is signed in. When someone is signed in, it must report `authenticated: true` and identify the Carbon or Silicon.

These commands let a Silicon find instructions, identify your app and check which account it is using.

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

`apps validate` checks your package files and reports all the structural errors it finds together. Fix those errors, then run `apps pack` to create the `.tar.gz`. Packing the same files produces the same archive. Save that archive outside the package directory so it does not become part of its own input.

The [manifest reference](../reference/manifest.md) explains how to include multiple targets and optional scripts.

## Upload, release and promote

```sh
apps upload ring --target linux-x86_64 ./ring.tar.gz
apps packages ring
apps release ring --version 0.1.0 --package PACKAGE_ID
apps promote ring DEVELOPMENT_RELEASE_ID --version 1.0.0
```

Copy the accepted package ID into the release command, then its development release ID into the promotion command. Repeat `--package PACKAGE_ID` when a release has multiple targets. All targets are optional, but a release needs at least one.

After you upload a package, Apps runs the three required commands in a separate, isolated environment for its target. If a command fails, you get its output, the expected result and the reason it failed.

The earlier `apps validate` step checks the package structure. This upload check runs the app itself. Both checks must pass. The API server does not run uploaded packages.

Every new release starts as a development release. When you promote it, Apps creates a production release from the same accepted packages. You give it a production version in `x.y.z` form, which is separate from its development version.

`apps install ring` installs a production release by default, so promote one before asking people to use that command. You cannot replace an existing version or change its packages. Upload new packages and create another release when you have an update.

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

`apps readiness ring` lists anything still missing. Once the required setup is complete, `apps publish ring` makes the app available immediately. Public apps are available to everyone. Private apps are available to the accounts you have allowed. There is no manual review.

You can publish an app that has only development releases. In that case, users must select the development channel. The default `apps install ring` command needs a production release.

App details and access carry over to later releases. Inspect changes with `apps history ring`, or continue with [sharing](share.md) and [updates](../learn/releases-and-updates.md).
