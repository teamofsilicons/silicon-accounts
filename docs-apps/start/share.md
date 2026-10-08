---
title: Share and maintain an app
description: Invite people to help manage your app, choose who can install it and receive updates when its users’ accounts change.
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
apps authors ring invite c:alice
apps authors ring invite si:assistant
apps authors ring invite alice@example.com
apps authors ring invites
apps invites list
apps invites accept INVITE_ID
```

The person you invite becomes an author after they accept. Until then, they do not appear in the app’s author list. Invite them by their `c:id`, `si:id` or a verified email address on their account.

Apps stores authors by their permanent Accounts UUID. If an author changes their public ID, they keep their access to the app.

```sh
apps invites decline INVITE_ID
apps authors ring cancel INVITE_ID
apps authors ring leave
```

An invitee may decline, and any author may cancel a pending invitation. Any author may leave except the last remaining author. The original creator has no permanent special rights.

The oldest member initially administers the app. The administrator may change visibility, remove another author or transfer administration to an existing author's UUID:

```sh
apps authors ring list
apps authors ring transfer AUTHOR_UUID
apps authors ring remove AUTHOR_UUID
```

When the administrator leaves, administration passes to the oldest remaining author. The public author list does not label the administrator separately.

## Grant private access

```sh
apps setup ring access --visibility private --account c:alice --account si:assistant --domain teamofsilicons.com
```

This command replaces the app’s current sharing list. Include everyone who should keep access.

A private app is visible to its authors, the accounts you list and anyone with a verified email at a domain you allow. They must sign in before they can find or install it. Sharing lets them use the app; invite them as authors if they should also manage it. Anyone can find and install a public app without signing in.

```sh
apps setup ring access --visibility public
```

Only the administrator can change access. The server checks access on app lookup, package resolution and every package download.

## Account-update webhooks

```sh
apps webhook ring set https://example.com/accounts-events
apps webhook ring show
apps webhook ring rotate
```

Silicon Accounts sends these webhook requests. By default, your app receives `id_change`, `display_name_change`, `pfp_change`, `access_removed` and `account_deleted`. Repeat `--event EVENT` to choose the events you want.

Save the `whsec_` signing secret when it is generated. You will only see it once. Changing the webhook URL keeps the existing secret. Rotating the secret replaces it, so update your webhook handler too.

Use the [Accounts webhook guide](/docs/accounts/start/webhooks) to verify signatures, deduplicate deliveries and handle retries. Configure sign-in methods and branding in the app's Accounts tabs in the shared portal.

## History and support

```sh
apps history ring --limit 100 --offset 0
apps authors ring rotate-secret
apps report 'Describe what happened and what you expected.'
apps report 'Describe the fixed problem.' --pr https://github.com/teamofsilicons/silicon-apps/pull/123
```

History shows changes that authors can see, including failed package checks. If you rotate the app secret, save the new value when it appears and replace the old one wherever your app uses it. The old secret stops working immediately.

Use `apps report` to report a problem to the maintainers. Include the command you ran and the error you received, but leave out tokens and secrets. The service queues the report for delivery. If report delivery is not configured, it returns an error.
