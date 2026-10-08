---
title: Silicon Accounts docs
description: Add sign-in to your app, manage Carbon and Silicon accounts and verify requests between apps. Find the guide for your next step.
kind: informative
order: 0
related:
  - start/add-sign-in.md
  - start/silicon-account.md
  - learn/accounts.md
  - reference/api.md
---

# Silicon Accounts

Silicon Accounts gives every **Carbon** (a person) and **Silicon** (an AI agent) one personal account. They use that account in every app they sign in to.

If you are building an app, Accounts handles sign-in for you. You choose the methods, the pages users see and the details they share. Accounts handles account creation, email and phone codes, Google and Apple sign-in, and your app’s user list.

Some requests are public. For example, you can check whether a public ID is available without signing in:

```sh
export ACCOUNTS_URL=https://accounts.teamofsilicons.com   # or a local stack: http://localhost:8590
curl -s "$ACCOUNTS_URL/v1/ids/available?id=si:head_of_growth"
```

```json
{"id": "si:head_of_growth", "available": true, "reason": null, "message": "si:head_of_growth is available.", "reclaimable": false, "suggestions": []}
```

The hosted service is available at [accounts.teamofsilicons.com](https://accounts.teamofsilicons.com).
For a local development stack, follow [Run it yourself](#run-it-yourself) and set
`ACCOUNTS_URL=http://localhost:8590` instead.

You can use the `silicon-accounts` CLI, the `silicon-accounts-client` Rust package or the HTTP API at `$ACCOUNTS_URL/v1/`. The CLI uses that same Rust package.

Run `silicon-accounts --help` to see the available commands, or add `--help` to a command for its options. The CLI includes guides you can read offline. `silicon-accounts docs` lists them, and `silicon-accounts docs imports` opens the import guide.

## Start here

**You are a Silicon.**

1. [Get an account](start/silicon-account.md): create it yourself and name your custodian, or
   have a Carbon create it for you. You get an si:id and an STK, your password.
2. [Sign in to apps](start/silicon-sign-in-to-apps.md): you never see an app's sign-in page;
   you hand the app a short-lived token.
3. [Use the CLI](start/cli.md), with the full [command reference](reference/cli.md).

**You are building an app.**

1. [Add sign-in](start/add-sign-in.md): send Carbons to the hosted pages, drop in the iframe or
   the snippet, or use any OpenID Connect library, then exchange the code for tokens.
2. [Configure sign-in](start/sign-in-config.md): methods and their order, redirect URIs,
   which details Carbons share with you (required or optional), your flows, who may sign in.
   The developer platform, [developers.teamofsilicons.com](https://developers.teamofsilicons.com),
   does all of it with live previews.
3. [Brand the pages](start/branding.md) so they look like your app.
4. [Import your existing users](start/import-users.md) so nobody starts over.
5. [Verify tokens](start/tokens.md), [receive webhooks](start/webhooks.md) about the accounts
   in your user base, and act at other apps with [proofs](start/verify-a-proof.md).

**You are a Carbon.** Your account lives at
[accounts.teamofsilicons.com](https://accounts.teamofsilicons.com): your details, your emails
and phone numbers, the apps you signed in to (and what each one sees), the proofs apps issued
on your behalf, and the Silicons you are custodian of. [Being a custodian](start/custodians.md)
explains what you are responsible for; [Accounts](learn/accounts.md) explains what your account
holds and what deleting it does.

## How these docs are organised

- **Start** pages are instructions. Each one begins with what you'll do and a working example,
  then every step, every option and every error you can meet.
- **Learn** pages explain why it works the way it does. Read them when you need to make a
  judgement call: the reasons are there so you can decide for yourself.
- **Reference** pages list everything: [the HTTP API](reference/api.md),
  [errors](reference/errors.md), [limits](reference/limits.md), the
  [Rust client](reference/rust-client.md) and the [CLI](reference/cli.md).

## The words

| word | meaning |
|---|---|
| Carbon | A person. Every person's account is a Carbon account. |
| Silicon | An agent. Its account is a Silicon account, with a password called an STK. |
| Custodian | The one Carbon responsible for a Silicon. Every Silicon always has exactly one. |
| App | Any application that signs its users in with Silicon Accounts. Apps are created in Silicon Apps; their sign-in is set up on the developer platform, developers.teamofsilicons.com. |
| uuid | The permanent identifier of an account, like `a8K`. It never changes and is never reused. |
| `c:id`, `si:id` | The public, changeable id of a Carbon or a Silicon, like `c:saket` or `si:head_of_growth`. |
| Membership | An account's relationship with an app: `{app_id}:{uuid}`, like `briefcase:a8K`. |
| STK | A Silicon's password: `stk-` followed by hexadecimal digits. |
| Short-lived token | What a Silicon (or a Carbon, from the CLI) hands an app to sign in to it: single use, 2 minutes. |
| User verification and App verification proofs | Tokens that let one app act at another, on behalf of a Carbon (User verification) or as itself (App verification). |

## Things to rely on

- **Store the uuid.** Ids change (the old one stays reserved for 10 days, then anyone may take
  it); the uuid never does. Apps hear about id changes by webhook.
  [uuids and ids](learn/ids-and-uuids.md) explains why.
- **Errors say exactly what went wrong and why.** Every error is
  `{"error": {"code", "message", "hint"?, "details"?}}`: a stable `code` to branch on, a
  `message` that names the problem, and usually a `hint` with the next step.
- **Keep the same key when retrying a change.** Requests that create a Silicon, import, proof, webhook secret or sign-in configuration change accept an `Idempotency-Key` header. Within the replay window, the same key and body return the original response. Removals can be repeated. See the [retry rules](reference/api.md#idempotency) before retrying other operations.
- **Personal accounts only.** Accounts are never shared and never belong to a group. A
  Carbon's account belongs to that Carbon, a Silicon's to that Silicon; apps get only what the
  Carbon shares with them.

Numbers worth knowing (all of them are in [limits](reference/limits.md)):

| what | value |
|---|---|
| Email and phone codes | 6 digits, valid 10 minutes; 10 per address per 10 minutes; 10 wrong in a row lock the address for 1 minute |
| Access token / refresh token | 30 minutes / up to 900 days |
| Short-lived token for an app | single use, 2 minutes |
| Id change | old id reserved 10 days |
| Custodian request | 14 days to accept |
| Emails, phone numbers | up to 10 each per Carbon |
| Import | up to 100,000 rows or 50 MB per file |

## Run it yourself

A local stack is the whole service on your machine: Postgres, `accounts-api`, the account site,
the developer platform (http://localhost:8600, where you sign in as an app's owner and set up its
sign-in), mock Google and Apple, a mock email and SMS sender, and fake apps (`briefcase`, `dm`, `remind`,
…) with fixed development secrets. No code reaches a real inbox or phone and no sign-in reaches
the real Google or Apple, so it is also the safe place to try a change before you make it in
production. From a checkout of the repository:

```sh
scripts/dev.sh --detach                     # builds, migrates, seeds and starts; prints every URL
export ACCOUNTS_URL=http://localhost:8590   # the account site; it forwards /v1/* and /.well-known/*
silicon-accounts id available si:head_of_growth     # the CLI reads ACCOUNTS_URL too (or pass --url)
scripts/stop.sh                             # stops the stack; Postgres keeps running (--db stops it)
```

It needs Rust 1.98, Node 24 or later with pnpm, and Postgres 16 (`PG_BIN` names the directory
with `pg_ctl` when it isn't Homebrew's `postgresql@16`). The stack builds the CLI as
`target/debug/silicon-accounts`; [Use the silicon-accounts CLI](start/cli.md#install) puts it on your `PATH`.
Email and SMS codes go to the mock sender; read them from the development outbox:
`curl -s "$ACCOUNTS_URL/v1/dev/outbox?to=ada@example.test&limit=1"`
([service endpoints](reference/api/service.md#get-v1devoutbox)). `scripts/dev.sh --help` lists
every option, including the ports and database of a second stack.

## Where to find more

- The account site: [accounts.teamofsilicons.com](https://accounts.teamofsilicons.com), where a
  Carbon manages their own account.
- The developer platform: [developers.teamofsilicons.com](https://developers.teamofsilicons.com),
  where developers set up everything about their apps' sign-in: methods, Google and Apple, the
  details they ask for, flows and pages, redirect URLs, user base and imports, webhooks and App verification
  proofs. The settings themselves are stored in Silicon Accounts.
- Discovery for OpenID Connect libraries:
  `https://accounts.teamofsilicons.com/.well-known/openid-configuration`, keys at
  `/.well-known/jwks.json`.
- Source of the service, the account site, the CLI, the Rust package and these docs: the
  `silicon-accounts` repository. Its public home,
  [github.com/teamofsilicons/silicon-accounts](https://github.com/teamofsilicons/silicon-accounts),
  includes the service, both frontends, client, CLI and documentation.
- Found a bug? `silicon-accounts report "what you ran, what you expected, what happened"`, with
  `--pr <link>` if you also fixed it.
