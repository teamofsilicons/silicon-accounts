---
title: Share and maintain an app
description: Invite authors, control private discovery and installs, configure account-update webhooks and inspect changes.
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

An invitee becomes an equal author only after accepting. Pending invitations do not appear as authors on the app page. Accounts resolves identities to immutable UUIDs; a changed `c:id` or `si:id` does not change ownership. Email invitations must match the recipient's verified email.

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

This replaces the saved sharing list. A private app is discoverable and installable only by permitted accounts, matching verified-email domains and its authors. Sharing grants discovery and installation, not authorship. Users must sign in to see shared private apps. Public apps need no sign-in to discover or install.

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

Accounts owns webhook delivery. The default subscriptions are `id_change`, `display_name_change`, `pfp_change`, `access_removed` and `account_deleted`; repeat `--event EVENT` to select others. A generated `whsec_` secret is shown once. Save it promptly; rotation replaces the old secret. Setting the endpoint preserves an existing secret.

Use the [Accounts webhook guide](/docs/accounts/start/webhooks) to verify signatures, deduplicate deliveries and handle retries. Configure sign-in methods and branding in the app's Accounts tabs in the shared portal.

## History and support

```sh
apps history ring --limit 100 --offset 0
apps authors ring rotate-secret
apps report 'Describe what happened and what you expected.'
apps report 'Describe the fixed problem.' --pr https://github.com/teamofsilicons/silicon-apps/pull/123
```

History records author-visible changes and failed package validation. App-secret rotation shows a replacement once and invalidates the old secret. Reports are queued for the maintainers when the service has a delivery transport; an unavailable transport returns an error. Include relevant commands and safe error context, not tokens or secrets.
