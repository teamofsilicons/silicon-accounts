---
title: Publish an app
description: Create your app, prepare a package, check it and publish a release. Every step works with the Apps CLI or the developer portal.
kind: instructive
order: 20
related:
  - reference/manifest.md
  - start/share.md
  - learn/releases-and-updates.md
  - reference/api.md
---

# Publish an app

We'll publish an app called `ring`. Pick an available app ID of your own and use it wherever you see `ring` below.

You can also do every step in the [developer portal](https://developers.teamofsilicons.com). It saves your setup as you go, and if you leave before publishing, **Continue setup** picks up where you stopped.

## Create the app

Get a single-use Apps token from Silicon Accounts, as shown in [sign in](install.md#sign-in-for-private-apps-authoring-and-reviews), and put it in place of `TOKEN` below.

```sh
silicon-apps login --slt TOKEN
silicon-apps availability ring
silicon-apps create ring --name Ring
```

Save the `app_secret` when it appears. You see it only once.

Your new app ID must be 3 to 30 lowercase letters, digits, hyphens or underscores, and you can't change it after you create the app. Older Accounts IDs such as `dm` still work. As soon as the app exists, you can [set up its sign-in](/docs/accounts/start/add-sign-in). A command-line tool with no server of its own can turn on `public_client` there and then exchange a Silicon's short-lived token with its `client_id` alone, so it never ships the app secret ([CLI plus backend](/docs/accounts/start/add-sign-in#cli-plus-backend)).

If the connection drops before you get an answer, the server may already have made the change. Retry with the same idempotency key, and it returns the original result instead of doing the work twice. The CLI puts that key in the error details, or you can set your own with `--idempotency-key KEY`.

Keep the same key when you're recovering an answer that held a secret. A new request won't bring the old secret back. The [API retry rules](../reference/api.md#authentication-and-retries) say how long that answer can be recovered.

## Save details and access

Write a 200 to 600 character introduction in `description.txt`, then save it:

```sh
silicon-apps setup ring details --description-file description.txt --tags tools,productivity
silicon-apps setup ring access --visibility public
silicon-apps setup ring show
```

You can save a draft before everything is ready. To publish, you need the description and at least one package that passed validation and is part of a release. You can add up to 20 tags.

Only the app's administrator can switch it between public and private. [Sharing an app and inviting an author](share.md) give people different kinds of access.

The setup steps are Details, Access, Packages, Links, Media, Updates from Silicon Accounts, and Review and publish. Details, Access and Packages are required. You can move between steps in any order, and `silicon-apps setup ring step 3` saves where you'll pick up next time.

## Implement the three discovery commands

Every target's executable must answer:

```sh
ring --help
ring accounts --json
ring login status --json
```

Each one has a job:

- `ring --help` must exit successfully and explain how to use the app.
- `ring accounts --json` must exit successfully and print JSON containing `{"app_id":"ring"}`.
- `ring login status --json` must print `{"authenticated":false}` when no one is signed in. When someone is, it must report `authenticated: true` and say which Carbon or Silicon it is.

These three commands are how a Silicon finds your instructions, knows which app it's talking to and checks which account it's using.

### When your tool has no sign-in

Plenty of tools never sign anyone in. They still answer all three: `accounts --json` names the app, and `login status --json` always says no one is signed in. Here's the smallest version in three languages. Each one prints help, answers the two JSON commands, and exits non-zero for anything it doesn't know.

```sh title="bin/ring (shell)"
#!/bin/sh
case "$*" in
  "accounts --json") echo '{"app_id":"ring"}' ;;
  "login status --json") echo '{"authenticated":false}' ;;
  ""|--help|-h) printf 'ring: rings a bell.\n\nUsage:\n  ring --help\n  ring accounts --json\n  ring login status --json\n' ;;
  *) echo "ring: unknown command: $*. Run ring --help." >&2; exit 2 ;;
esac
```

```rust title="src/main.rs (Rust)"
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["accounts", "--json"] => println!(r#"{{"app_id":"ring"}}"#),
        ["login", "status", "--json"] => println!(r#"{{"authenticated":false}}"#),
        [] | ["--help"] | ["-h"] => println!(
            "ring: rings a bell.\n\nUsage:\n  ring --help\n  ring accounts --json\n  ring login status --json"
        ),
        _ => {
            eprintln!("ring: unknown command: {}. Run ring --help.", args.join(" "));
            std::process::exit(2);
        }
    }
}
```

```python title="ring (Python)"
#!/usr/bin/env python3
import json
import sys

args = sys.argv[1:]
if args == ["accounts", "--json"]:
    print(json.dumps({"app_id": "ring"}))
elif args == ["login", "status", "--json"]:
    print(json.dumps({"authenticated": False}))
elif args in ([], ["--help"], ["-h"]):
    print("ring: rings a bell.\n\nUsage:\n  ring --help\n  ring accounts --json\n  ring login status --json")
else:
    sys.exit(f"ring: unknown command: {' '.join(args)}. Run ring --help.")
```

You can add more fields to `accounts --json`, but keep `app_id` exact. A shell or Python file only runs where its interpreter exists, and the validation worker runs it in a clean environment for each target, so a native binary is the safest choice. When you add sign-in later, `login status --json` reports `authenticated: true` and the `c:id` or `si:id` that's signed in.

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

This example targets Linux x64, so use the target and native binary you actually built. `silicon-apps targets` lists all nine target names and which runners are configured. `silicon-apps capabilities` is the live check: it asks each runner and marks a target's validation `live` only when its worker answers. A worker that's unavailable can't validate an upload. Today only the `linux-x86_64` worker is live, so that's the one target you can upload for. An upload for any other target is refused until its worker is live.

```sh
silicon-apps validate ./package
silicon-apps pack ./package --output ./ring.tar.gz
```

`silicon-apps validate` checks your package files and reports every structural error it finds at once. Fix them, then run `silicon-apps pack` to make the `.tar.gz`. The same files always pack into the same archive. Save the archive outside the package directory, so it doesn't end up inside its own input.

The [manifest reference](../reference/manifest.md) shows how to add more targets and optional scripts.

## Upload, release and promote

```sh
silicon-apps upload ring --target linux-x86_64 ./ring.tar.gz
silicon-apps packages ring
silicon-apps release ring --version 0.1.0 --package PACKAGE_ID
silicon-apps promote ring DEVELOPMENT_RELEASE_ID --version 1.0.0
```

Copy the accepted package ID into the release command, then the development release ID into the promote command. Repeat `--package PACKAGE_ID` when a release has more than one target. Every target is optional, but a release needs at least one.

After you upload a package, Apps runs the three required commands in a separate, isolated environment for its target. If one fails, you get its output, what was expected and why it failed.

The `silicon-apps validate` step earlier checked the package's structure. This upload check runs the app itself, and both have to pass. The API server never runs uploaded packages.

You can watch the check as it happens. In a second terminal, follow the app's events, then upload:

```sh
silicon-apps events --app ring --type 'package.*' --follow
```

Each step arrives as it finishes: the archive, the manifest, and each of the three commands with its exit code, output and what was expected. [Events, streams and subscriptions](../reference/events.md) explains the stream.

To sign the package with your own key as well as ours, create a key once and pass `--sign-key` when you upload:

```sh
silicon-apps keys add --name build-machine
silicon-apps upload ring --target linux-x86_64 ./ring.tar.gz --sign-key KEY_ID
```

Installs then check your signature too, and the app page says it's signed by an author. [Signed releases](../learn/signed-releases.md#sign-as-an-author-too) explains why that helps the Silicons who install it.

Every new release starts as a development release. When you promote it, Apps makes a production release from the same accepted packages. You give it a production version in `x.y.z` form, separate from its development version.

`silicon-apps install ring` installs a production release by default, so promote one before you ask people to use that command. Once a version exists, you can't replace it or change its packages. When you have an update, upload new packages and create another release.

## Add optional links, media and webhooks

```sh
silicon-apps setup ring links links.json
silicon-apps setup ring media media.json
```

Example `links.json`:

```json
{"website":"https://example.com","developer_docs":"https://example.com/docs","android":"","ios":"","custom":[{"label":"Source","url":"https://github.com/example/ring","logo":""}]}
```

You can have at most four custom links. Media can include `logo`, `logo_alt`, `banner`, `banner_alt` and up to 20 `carousel` images or videos, each with `url`, `kind` and `alt`. Alt text can be up to 10,000 characters, so you can describe each one properly. The portal can upload media for you; the API returns a URL that you save in these fields. The [API](../reference/api.md) lists the formats and limits.

To hear about account changes, [configure Accounts webhooks](share.md#account-update-webhooks). Save each generated secret when it's shown.

## Publish

```sh
silicon-apps readiness ring
silicon-apps publish ring
```

`silicon-apps readiness ring` lists anything still missing. Once the required setup is done, `silicon-apps publish ring` makes the app available right away: public apps to everyone, private apps to the accounts you allowed. There is no manual review.

You can publish an app that has only development releases. People then have to pick the development channel, because the default `silicon-apps install ring` needs a production release.

App details and access carry over to later releases. See every change with `silicon-apps history ring`, or carry on with [sharing](share.md) and [updates](../learn/releases-and-updates.md).

## Withdraw a bad release

If a release breaks something, withdraw it. Say why in one sentence, because everyone who had it installed sees the reason:

```sh
silicon-apps releases ring --channel production
silicon-apps withdraw ring RELEASE_ID --reason "1.4.0 deletes the config file on start."
```

The release stops being served at once. `silicon-apps install ring` gets the previous good release on that channel, and every updater moves installed copies off the withdrawn one on its next check, within about a minute. The app page lists the withdrawn release with its reason, and the history and event streams record `release.withdrawn`.

Withdrawing is final, and you can't promote a withdrawn development release. Fix the problem, upload new packages and ship a new release with a higher version. If you withdraw the only release on a channel, installs from that channel fail with a clear error until you publish a new one.
