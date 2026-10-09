---
title: What your app sees about an account
description: Which account details your app gets, how a Carbon agrees to share them, and how webhooks keep your copy up to date.
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

Your app gets the account details the account has agreed to share with you. We show you that same view everywhere: the `account` field of the token response, `/v1/userinfo`, your app's user base and its webhooks. (One gap: the user base leaves out a Silicon's `custodian`, see below.)

This page covers which fields you get, how required and optional details are shared and how to keep your copy up to date when they change.

## Store the uuid

| Identifier | Example | Changes? | Use it for |
|---|---|---|---|
| `uuid` | `ptO` | Never, and never reused, even after the account is deleted | The key of your user record |
| `membership_id` | `briefcase:ptO` | Never (`{app_id}:{uuid}`) | A key that also says which app, when you store several apps' users together |
| `id` | `c:grace-hopper`, `si:scout` | Yes, whenever the account renames itself | Showing who someone is |

The `c:`/`si:` id can change at any time, and 10 days after a change the old id is free for someone else to take. Key anything on it and one day you'll attach one account's data to another. When an id changes, your webhook hears about it:

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
| (Silicons) | `custodian: {uuid, id}` | The Carbon responsible for it, in the token response's `account`, `/v1/userinfo`, `GET /v1/accounts/{uuid}` and `account.updated`. It is `null` only while a self-created Silicon waits for its custodian to accept. Such a Silicon can't sign in yet, so you only meet that in a lookup (`GET /v1/accounts/{uuid}`). Not in the access token or `id_token` claims, and not in your user base (`/v1/apps/{app_id}/users`). |

`version` goes up with every change to the account, and `updated_at` is when it last changed. A detail outside the granted scopes is just absent, never `null`. We only ever share the primary email and phone: a Carbon can have up to 10 of each, and the others stay private.

Here's a Carbon and a Silicon after the same kind of sign-in:

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

A Silicon has no email or phone, so asking for them never blocks a Silicon; those fields are just left out. If your app needs to reach a Carbon about a Silicon, its custodian is the Carbon responsible for it.

## The what's-shared screen

The first time an account signs in to your app, the hosted pages show exactly what your app will get before anything is shared. These are your app's **details pages**. It's either one page with every detail you ask for, or the pages of your own [flow](../start/sign-in-config.md#flows) (say, "How can we reach you?" with the phone, then "About you" with the date of birth and timezone). If you turn it on, a review page of everything that will be shared comes last.

| Shown as | For | The Carbon can |
|---|---|---|
| "Name, id and profile photo: Grace Hopper (c:grace-hopper)" (first page) | `profile` | only accept |
| "Email address: g***@example.com", with a lock | each of your `required_fields` | only accept (and add it first when it's missing) |
| "Timezone: Asia/Kolkata", with a checkbox | each of your `optional_fields`, and each detail you ask for in `scope` that isn't required (on the last page) | tick it to share it |

Values are shown the way your app will get them (email and phone masked on screen). An optional checkbox starts unticked, unless the account shared that detail with your app before, or the Carbon added the email or phone on the page just now. Back keeps the answers on every page. Cancelling on any page sends the browser back with `error=access_denied`: nothing is shared and no membership is created.

The answers become the grant: `profile`, the required details and the ticked optional ones (plus `openid` when you asked for it). An optional detail on a page the Carbon didn't see this time keeps what they granted before. We only show the pages again when they have something new to ask:

- **Skipped** when the account's membership is active and already grants `profile`, every required detail and every detail your `scope` asks for. Most sign-ins after the first go straight back to your app, with no review page either.
- **Shown again**, only the pages with something new, when you start requiring a new detail, ask for a new one in `scope`, or a required email or phone is no longer on the account. Every page is shown again with `prompt=consent`, or when the account had removed your access.

Grants add up: a later sign-in that asks for less still returns everything granted so far. On a page shown again, the Carbon's new answer replaces the old one, and that's how an optional detail can be taken back. Silicons never see these pages. Their short-lived token grants `profile` plus the date of birth and timezone your app asks for.

## Required details

A required `email` or `phone` must be a verified primary on the account. If it's missing, the details page that asks for it lets the Carbon add it right there: they type it, prove it with a 6-digit code, and it's theirs (and their primary, if they had none). Continue stays blocked until it's added. An address that already belongs to another account is refused (`email_in_use` / `phone_in_use`). Date of birth and timezone are never missing, because every account has both from the moment it exists. An optional email or phone the account doesn't have can be added the same way, and then starts ticked.

Required details are why a Carbon who signs in by phone can still be asked to add an email. With `allowed_email_domains`, every way in only lets through an account with a verified email at one of your domains:

- a Carbon who signs in by phone and has no such email is refused (`403 email_domain_not_allowed`);
- a new Carbon signing up by phone is asked for an email at your domains before the sign-in completes, when your app requires an email; without that, a phone sign-up is refused at once.

A Carbon using the CLI to get a short-lived token can't add a detail there, so a missing detail answers `409 requirements_missing` and names it.

## Your user base

Every Carbon and Silicon that signed in to your app (or that you imported) is in your user base, with the details it shares with you. The columns are fixed; apps can't add their own.

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

`source` tells you how the membership started: `signin` for the hosted pages, `slt` for a short-lived token, or `import`.

Use `q` to search the uuid, public id, display name, `external_id` and imported emails or phone numbers. Searching a primary email or phone number needs the matching scope, so search can never find a detail the account hasn't shared with you. You can also filter by `status`, `kind` and `source`, and page through results with `limit` (up to 200) and `cursor`.

`history` lists the last 20 sign-ins to your app with their time, method and outcome. Methods are `email`, `phone`, `google`, `apple`, `session`, `device` (your tool's device sign-in), `slt` (a Silicon's short-lived token, exchanged with your secret) and `slt_public_client` (the same token, exchanged by your own tool with `public_client` on). It never includes IP addresses. For imports, see [Import existing users](../start/import-users.md).

## Stay in sync: webhooks

Tokens show the account as it was at sign-in; webhooks tell you when it changes. Register one endpoint for your app. The answer carries the signing secret, shown once:

```sh
curl -s -X PUT -u "${ACCOUNTS_APP_ID}:${ACCOUNTS_APP_SECRET}" "$ACCOUNTS_URL/v1/apps/$ACCOUNTS_APP_ID/webhook" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: set-webhook-1' \
  -d '{"url": "https://briefcase.example/hooks/accounts"}'
# {"events":null,"secret":"whsec_ha5wDQgUlYp64OOPVqUSpWQMAPvF7fkye6atRTmyXMY","url":"https://briefcase.example/hooks/accounts"}
```

The first PUT makes the signing secret and shows it once. Later PUTs keep it (`"secret": null`)
and keep the updates you picked unless you send `events`; a new webhook gets every update.
`POST …/webhook/rotate-secret` makes a new secret. [Receive webhooks](../start/webhooks.md) has the
details.

Your app hears about every account that is a member (active or imported):

| Event | When | What to do |
|---|---|---|
| `account.id_changed` | The `c:`/`si:` id changed. | Update the id you display. |
| `account.updated` | A detail your app may see changed: `data.changed` lists them, `data.account` is the new view. | Update your copy. |
| `account.deleted` | The account was deleted. | Delete or anonymise its data. |
| `membership.signed_out` | One of your sign-ins ended. `data.reason`: `app_revoked` (your app revoked it), `refresh_token_reuse`, `authorization_code_reuse` (a token or code was used twice), `stk_rotated` (a Silicon's custodian rotated its STK) or `session_revoked` (a Silicon's CI trust was removed, ending the sign-ins made from it). | End your own session for it. |
| `membership.access_removed` | The account removed your app's access. | End its sessions; you no longer receive its details. |
| `silicon.custodian_changed` | A member Silicon moved to another custodian. `data.from` and `data.to` are the old and new custodian as `{uuid, id}`. | Update who is responsible for it. |
| `ping` | You sent a test. | Answer 2xx. |

`account.updated` respects scopes: your app only hears about details it may see, and its `data.account` holds only those. Scopes belong to each membership, not to the app, so two members of the same app can differ. When Lin renamed herself and changed her timezone, briefcase (where Lin had granted `timezone`) got `"changed": ["display_name", "timezone"]` with the new timezone in `data.account`. dm, where she hadn't, got `"changed": ["display_name"]` and no timezone at all. A change your app can't see sends it nothing.

Every delivery is signed (`X-Accounts-Signature: v1=<hex HMAC-SHA256(secret, "{timestamp}.{raw body}")>`), carries an `event_id` to deduplicate on, and is retried until your endpoint answers 2xx (for up to 72 hours, then you can replay it). How to verify, retry, replay and order them is in [Receive webhooks](../start/webhooks.md) and [How webhooks work](webhooks.md).

## What your app never sees

- An account's other emails and phones, or any detail outside its grant.
- How the account signs in to Silicon Accounts (which emails, Google or Apple identities) and where from. Sign-in history shows your app the method and outcome, never an IP address.
- Its other apps, and what it shares with them.
- A Silicon's STK, its webhook, or anything about its custodian beyond the custodian's uuid and id, `silicon.custodian_changed` included.
- Anything at all after the account removed your access, except that it did.

## When a Silicon works for its custodian

A Silicon often works for its custodian, so your app may want to let it reach the custodian's
data. Here is exactly what we give you:

- **You know who the custodian is.** Every Silicon sign-in returns `account.custodian` (`uuid` and
  `id`), and `/v1/userinfo` gives it again. That tells you which Carbon answers for the Silicon. It
  doesn't let the Silicon act as that Carbon.
- **There is no delegation grant.** A Silicon's sign-in is always the Silicon itself: a
  short-lived token signs in the account that made it, and no grant lets one account act for
  another at your app (our token exchange refuses an `actor_token`). User verification proofs let
  one app act at another for the same account. They don't let a Silicon act for its Carbon.

So let the Carbon decide, inside your app:

1. The Carbon signs in to your app as themselves.
2. They allow their Silicon there, for example with a "Let si:scout use my notes" setting. Store
   the Silicon's uuid next to the Carbon's uuid.
3. When the Silicon signs in, check that its `account.custodian.uuid` is the Carbon who allowed it
   before you show it the Carbon's data. Compare uuids, never ids.
4. Make sure your webhook gets the `custodian_change` update (it isn't among the recommended
   defaults), and drop the permission when `silicon.custodian_changed` says the Silicon has a new
   custodian.

The Carbon can take the permission back in your app at any time, and nothing about it changes
what the Silicon can do anywhere else.
