---
title: What your app sees about an account
description: Learn which account details your app receives, how users agree to share them and how webhooks keep your copy up to date.
kind: informative
order: 12
related:
  - start/hosted-pages.md
  - start/tokens.md
  - learn/ids-and-uuids.md
  - start/webhooks.md
  - start/import-users.md
  - learn/accounts.md
---

# What your app sees about an account

Your app receives the account details the user has agreed to share. Accounts uses that same view in the token response’s `account` field, `/v1/userinfo`, your app’s user list and its webhooks.

This page explains which fields you receive, how required and optional details are shared and how to update your copy when they change.

## Store the uuid

| Identifier | Example | Changes? | Use it for |
|---|---|---|---|
| `uuid` | `ptO` | Never, and never reused, even after the account is deleted | The key of your user record |
| `membership_id` | `briefcase:ptO` | Never (`{app_id}:{uuid}`) | A key that also says which app, when you store several apps' users together |
| `id` | `c:grace-hopper`, `si:scout` | Yes, whenever the account renames itself | Showing who someone is |

The `c:`/`si:` id can change at any time, and 10 days after a change the old id is free for
someone else to take. Key anything on it and you will one day attach one account's data to
another. When an id changes, your webhook hears it:

```json
{
  "app_id": "briefcase",
  "data": {"kind": "carbon", "membership_id": "briefcase:nln", "new_id": "c:lin", "old_id": "c:lin-docs", "uuid": "nln"},
  "event_id": "01a1143a-b090-7231-a677-dfc98fc003cd",
  "occurred_at": "2026-10-07T02:39:13.040Z",
  "silicon": null,
  "type": "account.id_changed"
}
```

The full story of ids is in [Ids and uuids](ids-and-uuids.md).

## What each scope shares

| Scope | Fields | Notes |
|---|---|---|
| `profile` (always) | `uuid`, `membership_id`, `kind`, `id`, `display_name`, `pfp_url`, `updated_at`, `version` | Granted with every sign-in; it can't be declined. |
| `email` | `email`, `email_verified` | The account's primary email. Carbons only. |
| `phone` | `phone`, `phone_verified` | The primary phone, in E.164 (`+12025550147`). Carbons only. |
| `dob` | `dob` | `YYYY-MM-DD`. A Silicon's is the day its account was created. |
| `timezone` | `timezone` | An IANA name such as `Asia/Kolkata`. |
| (Silicons) | `custodian: {uuid, id}` | Always present for a Silicon: the Carbon responsible for it. |

`version` grows with every change to the account; `updated_at` is when it last changed. A
detail outside the granted scopes is simply absent, never `null`. Only the primary email and
phone are ever shared: a Carbon can have up to 10 of each, and the others stay private.

A Carbon and a Silicon after the same kind of sign-in:

```json
{
  "uuid": "ptO",
  "membership_id": "briefcase:ptO",
  "kind": "carbon",
  "id": "c:grace-hopper",
  "display_name": "Grace Hopper",
  "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=ptO",
  "email": "grace.hopper@example.com",
  "email_verified": true,
  "updated_at": "2026-10-07T02:56:29.875Z",
  "version": 1
}
```

```json
{
  "uuid": "1Nx",
  "membership_id": "briefcase:1Nx",
  "kind": "silicon",
  "id": "si:scout",
  "display_name": "Scout",
  "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=1Nx",
  "timezone": "Asia/Kolkata",
  "custodian": {"uuid": "ptO", "id": "c:grace-hopper"},
  "updated_at": "2026-10-07T02:56:54.507Z",
  "version": 1
}
```

A Silicon has no email or phone, so asking for them never blocks a Silicon: those fields are
just left out. If your app needs to reach a Carbon about a Silicon, the custodian is the
Carbon responsible for it.

## The what's-shared screen

The first time an account signs in to your app, the hosted pages show what your app will
receive before anything is shared. These are your app's **details pages**: one page with every
detail you ask for, or the pages of your own [flow](../start/sign-in-config.md#flows) (say,
"How can we reach you?" with the phone, then "About you" with the date of birth and timezone),
and, when you turn it on, a review page of everything that will be shared.

| Shown as | For | The Carbon can |
|---|---|---|
| "Name, id and profile photo: Grace Hopper (c:grace-hopper)" (first page) | `profile` | only accept |
| "Email address: g***@example.com", with a lock | each of your `required_fields` | only accept (and add it first when it's missing) |
| "Timezone: Asia/Kolkata", with a checkbox | each of your `optional_fields`, and each detail you ask for in `scope` that isn't required (on the last page) | tick it to share it |

Values are shown the way your app will get them (email and phone masked on screen). An
optional checkbox starts unticked, unless the account shared that detail with your app before,
or the Carbon added the email or phone on the page just now. Back keeps the answers of every
page. Cancelling on any page sends the browser back with `error=access_denied`; nothing is
shared and no membership is created.

The answers become the grant: `profile`, the required details, and the ticked optional ones
(plus `openid` when you asked for it). An optional detail on a page the Carbon didn't see this
time keeps what they granted before. The pages are shown again only when they have something new
to ask:

- **Skipped** when the account's membership is active and already grants `profile`, every
  required detail and every detail your `scope` asks for. Most sign-ins after the first go
  straight back to your app (no review page either).
- **Shown again**, only the pages with something new, when you start requiring a new detail,
  ask for a new one in `scope`, or a required email or phone is no longer on the account. Every
  page is shown again with `prompt=consent`, or when the account had removed your access.

Grants accumulate: a later sign-in that asks for less still returns everything granted so far.
On a page shown again, the Carbon's new answer replaces the old one, which is how an optional
detail can be taken back. Silicons never see these pages: their short-lived token grants
`profile` plus the date of birth and timezone your app asks for.

## Required details

A required `email` or `phone` must be a verified primary on the account. If it's missing, the
details page that asks for it lets the Carbon add it right there: they type it, prove it with
a 6-digit code, and it becomes theirs (and the primary, if they had none). Continue stays
blocked until it is added. An address that already belongs to another account is refused
(`email_in_use` / `phone_in_use`). Date of birth and timezone are never missing: every account
has both from the moment it exists. An optional email or phone the account lacks can be added the
same way, and then starts ticked.

Required details are why a Carbon who signs in by phone can still be required to add an email.
With `allowed_email_domains`, the details page only accepts an email at your domains; but a
Carbon who signs in by phone and already has a verified email elsewhere doesn't add one, so your
app can receive an email outside your domains (keep `phone` off on such an app). A Carbon using
the CLI to get a short-lived token can't add a detail there, so a missing detail answers
`409 requirements_missing` and names it.

## Your user base

Every Carbon and Silicon that signed in to your app (or that you imported) is in your user
base, with the details it shares with you. The columns are fixed; apps can't add their own.

```sh
silicon-accounts app users                 # or: curl -u "${ACCOUNTS_APP_ID}:${ACCOUNTS_APP_SECRET}" "$ACCOUNTS_URL/v1/apps/$ACCOUNTS_APP_ID/users"
```

```text
UUID  ID             NAME         STATUS  SOURCE  CONTACT                   LAST SIGN-IN
ywD   c:oidc2-docs   Oidc2 Docs   active  signin  oidc2-docs@example.test   2026-10-07T02:45:17Z
sV0   si:scout-docs  Scout        active  slt                               2026-10-07T02:51:57Z
nln   c:lin          Lin Okafor   active  signin  lin-docs@example.test     2026-10-07T02:53:34Z
```

One entry of `GET /v1/apps/{app_id}/users/{uuid}`:

```json
{
  "account_status": "active",
  "created_at": "2026-10-07T02:38:14.621Z",
  "display_name": "Scout",
  "external_id": null,
  "first_signed_in_at": "2026-10-07T02:38:14.621Z",
  "granted_scopes": ["profile", "timezone"],
  "history": [
    {"at": "2026-10-07T02:38:22.865Z", "method": "slt", "outcome": "success"},
    {"at": "2026-10-07T02:38:14.621Z", "method": "slt", "outcome": "success"}
  ],
  "id": "si:scout-docs",
  "kind": "silicon",
  "last_signed_in_at": "2026-10-07T02:38:22.865Z",
  "membership_id": "briefcase:sV0",
  "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=sV0",
  "source": "slt",
  "status": "active",
  "timezone": "Asia/Kolkata",
  "uuid": "sV0"
}
```

| `status` | Meaning | Contact details shown |
|---|---|---|
| `active` | Signed in and sharing. | The current primary email/phone, dob and timezone, within `granted_scopes`. |
| `imported` | You imported it and it hasn't signed in to your app yet. | The values you imported. |
| `access_removed` | The account removed your app's access on the account site. | None. `granted_scopes` still lists what was granted before. |
| `deleted` | The account was deleted. Listed only with `status=deleted`. | None; `display_name` is "Deleted account" and `id` is `null`. Your `external_id` stays. |

The `source` field tells you how the membership started: `signin` for the hosted pages, `slt` for a short-lived token or `import`.

Use `q` to search the UUID, public ID, display name, `external_id` and imported emails or phone numbers. Searching a primary email or phone number requires the corresponding scope. You cannot use search to find details the account has not shared. You can also filter by `status`, `kind` and `source`, then page through results with `limit` (up to 200) and `cursor`.

The `history` field lists the last 20 sign-ins to your app with their time, method and outcome. Methods are `email`, `phone`, `google`, `apple`, `session` and `slt`. It does not include IP addresses. See [Import existing users](../start/import-users.md) for imports.

## Stay in sync: webhooks

Tokens show the account as it was at sign-in; webhooks tell you when it changes. Register one
endpoint for your app; the answer carries the signing secret, shown once:

```sh
curl -s -X PUT -u "${ACCOUNTS_APP_ID}:${ACCOUNTS_APP_SECRET}" "$ACCOUNTS_URL/v1/apps/$ACCOUNTS_APP_ID/webhook" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: set-webhook-1' \
  -d '{"url": "https://briefcase.example/hooks/accounts"}'
# {"secret":"whsec_ha5wDQgUlYp64OOPVqUSpWQMAPvF7fkye6atRTmyXMY","url":"https://briefcase.example/hooks/accounts"}
```

Your app hears about every account that is a member (active or imported):

| Event | When | What to do |
|---|---|---|
| `account.id_changed` | The `c:`/`si:` id changed. | Update the id you display. |
| `account.updated` | A detail your app may see changed: `data.changed` lists them, `data.account` is the new view. | Update your copy. |
| `account.deleted` | The account was deleted. | Delete or anonymise its data. |
| `membership.signed_out` | One of your sign-ins ended. `data.reason`: `app_revoked` (your app revoked it), `refresh_token_reuse`, `authorization_code_reuse` (a token or code was used twice) or `stk_rotated` (a Silicon's custodian rotated its STK). | End your own session for it. |
| `membership.access_removed` | The account removed your app's access. | End its sessions; you no longer receive its details. |
| `silicon.custodian_changed` | A member Silicon moved to another custodian. | Update who is responsible for it. |
| `ping` | You sent a test. | Answer 2xx. |

`account.updated` respects scopes: an app only hears about details it may see, and its
`data.account` contains only those. Scopes belong to each membership, not to the app, so two
members of the same app can differ. When Lin renamed herself and changed her timezone,
briefcase, where Lin had granted `timezone`, got `"changed": ["display_name", "timezone"]` with
the new timezone in `data.account`, while dm, where she hadn't, got `"changed": ["display_name"]`
and no timezone at all. A change your app can't see sends it nothing.

Every delivery is signed (`X-Accounts-Signature: v1=<hex HMAC-SHA256(secret, "{timestamp}.{raw body}")>`),
carries an `event_id` to deduplicate on, and is retried until your endpoint answers 2xx (up to
72 hours, then replayable). How to verify, retry, replay and order them is in
[Receive webhooks](../start/webhooks.md) and [How webhooks work](webhooks.md).

## What your app never sees

- An account's other emails and phones, or any detail outside its grant.
- How the account signs in to Silicon Accounts (which emails, Google or Apple identities) and
  where from: sign-in history shows your app the method and outcome, never an IP address.
- Its other apps, and what it shares with them.
- A Silicon's STK, its webhook, or its custodian's details beyond the custodian's uuid and id.
- Anything at all after the account removed your access, except that it did.
