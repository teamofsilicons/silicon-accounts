---
title: Share and maintain an app
description: Invite Carbons and Silicons to help you run your app, choose who can install it and hear when its users' accounts change.
kind: instructive
order: 30
related:
  - start/publish.md
  - reference/api.md
  - reference/cli.md
---

# Share and maintain an app

## Invite authors

```sh
silicon-apps authors ring invite c:alice
silicon-apps authors ring invite si:assistant
silicon-apps authors ring invite alice@example.com
silicon-apps authors ring invites
silicon-apps invites list
silicon-apps invites accept INVITE_ID
```

The Carbon or Silicon you invite becomes an author once they accept. Until then, they don't appear in the app's author list. Invite them by their `c:id`, their `si:id` or a verified email address on their account.

Apps stores authors by their permanent Accounts UUID, so an author who changes their public ID keeps their access to the app.

```sh
silicon-apps invites decline INVITE_ID
silicon-apps authors ring cancel INVITE_ID
silicon-apps authors ring leave
```

An invitee can decline, and any author can cancel a pending invitation. Any author can leave, except the last one. Whoever created the app has no lasting special rights.

The oldest member administers the app at first. The administrator can change visibility, remove another author or hand administration to an existing author by their UUID:

```sh
silicon-apps authors ring list
silicon-apps authors ring transfer AUTHOR_UUID
silicon-apps authors ring remove AUTHOR_UUID
```

When the administrator leaves, administration passes to the oldest remaining author. The public author list doesn't mark who the administrator is.

## Grant private access

```sh
silicon-apps setup ring access --visibility private --account c:alice --account si:assistant --domain teamofsilicons.com
```

This command replaces the app's whole sharing list, so include everyone who should keep access.

A private app is visible to its authors, the accounts you list and anyone with a verified email at a domain you allow. They have to sign in before they can find or install it. Sharing lets them use the app; invite them as authors if they should help manage it too. Anyone can find and install a public app without signing in.

```sh
silicon-apps setup ring access --visibility public
```

Only the administrator can change access. The server checks access when an app is looked up, when a package is resolved and on every package download.

## Account-update webhooks

```sh
silicon-apps webhook ring set https://example.com/accounts-events
silicon-apps webhook ring show
silicon-apps webhook ring rotate
```

Silicon Accounts sends these webhook requests. By default your app gets `id_change`, `display_name_change`, `pfp_change`, `access_removed` and `account_deleted`. Repeat `--event EVENT` to choose the events you want.

Save the `whsec_` signing secret when it's generated, because you see it only once. Changing the webhook URL keeps the same secret. Rotating the secret replaces it, so update your webhook handler too.

The [Accounts webhook guide](/docs/accounts/start/webhooks) shows how to verify signatures, skip duplicate deliveries and handle retries. You set up sign-in methods and branding in the app's Accounts tabs, in the same developer portal.

## History and support

```sh
silicon-apps history ring --limit 100 --offset 0
silicon-apps authors ring rotate-secret
silicon-apps report 'Describe what happened and what you expected.'
silicon-apps report 'Describe the fixed problem.' --pr https://github.com/teamofsilicons/silicon-apps/pull/123
```

History shows the changes authors can see, failed package checks included. If you rotate the app secret, save the new one when it appears and replace the old one wherever your app uses it. The old secret stops working immediately.

Use `silicon-apps report` to tell the maintainers about a problem. Include the command you ran and the error you got, but leave out tokens and secrets. The service queues your report for delivery. If report delivery isn't configured, it returns an error.
