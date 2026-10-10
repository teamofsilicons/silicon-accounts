---
title: Accounts
description: What a Carbon or Silicon account holds, how you manage its emails and phone numbers, and what happens when it is deleted.
kind: informative
order: 5
related:
  - learn/ids-and-uuids.md
  - learn/silicons-and-custodians.md
  - learn/what-apps-see.md
  - learn/imports.md
  - start/silicon-account.md
  - start/cli.md
  - learn/data-we-keep.md
---

# Accounts

Every Carbon and every Silicon has one personal account. A **Carbon** is a person and a **Silicon** is an agent. They take that same account into every app they sign in to.

An account belongs to its Carbon or Silicon alone; there are no shared or group accounts. Every Silicon also has a **custodian**, the Carbon responsible for its account.

This page covers what each kind of account holds and the rules for changing it. You can see your own account with one command:

```sh
silicon-accounts whoami
```

```text
c:ada · Ada Lovelace (Carbon)
uuid          8HV
status        active
timezone      Europe/London
dob           1990-12-10
photo         https://iris.teamofsilicons.com/pfp/carbon?id=8HV
created       2026-10-07T02:30:36Z
emails        ada@example.com (primary)
custodian of  1 Silicon
```

Or over HTTP, with the access token of a signed-in session (`Authorization: Bearer …`):

```sh
curl -s -H "Authorization: Bearer $ACCESS_TOKEN" "$ACCOUNTS_URL/v1/me"
```

```json
{
  "uuid": "8HV",
  "kind": "carbon",
  "id": "c:ada",
  "display_name": "Ada Lovelace",
  "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=8HV",
  "dob": "1990-12-10",
  "timezone": "Europe/London",
  "status": "active",
  "created_at": "2026-10-07T02:30:36.898Z",
  "updated_at": "2026-10-07T02:31:35.739Z",
  "version": 2,
  "emails": [
    {"email": "ada@example.com", "is_primary": true, "verified_at": "2026-10-07T02:31:35.739Z", "verified_via": "code"}
  ],
  "phones": [],
  "identities": [],
  "custodian_of": 1
}
```

## Every account

| field | what it is |
|---|---|
| `uuid` | The permanent identifier: a random 128-bit UUIDv4, written as 36 lowercase hexadecimal characters with hyphens. Apps store this. Existing short identifiers move once through the coordinated [UUID migration](../operations/account-uuid-migration.md); UUIDs are never reused, even after deletion. |
| `kind` | `carbon` or `silicon`. |
| `id` | The public id Carbons and Silicons see and type: `c:ada` for a Carbon, `si:scout` for a Silicon. Unique, changeable, case-insensitive (stored lowercase). `null` once the account is deleted. |
| `display_name` | 1 to 100 characters, no control characters (newlines, tabs). |
| `pfp_url` | The profile photo. By default a generated image from Iris (`…/pfp/carbon?id=<uuid>` or `…/pfp/silicon?id=<uuid>`). |
| `dob` | Date of birth, `YYYY-MM-DD`. |
| `timezone` | An IANA timezone such as `Asia/Kolkata` or `UTC`. |
| `status` | `active`, `unclaimed`, `pending_custodian` or `deleted` (below). |
| `created_at`, `updated_at` | RFC 3339 UTC timestamps with milliseconds. |
| `version` | Goes up with every change to the account, so anyone holding a copy can tell which one is newer. |

Ids have rules of their own (the 10-day hold after a change, reclaiming an old id, at most 5 changes in 24 hours, reserved words), all in [uuids and ids](ids-and-uuids.md). An account's membership with an app is written `{app_id}:{uuid}`, for example `briefcase:8HV`, for Carbons and Silicons alike.

### Statuses

| status | meaning |
|---|---|
| `active` | A normal account. |
| `unclaimed` | A Carbon account an app created by [importing](imports.md) its users. Its owner finishes it the first time they sign in with the address it carries; until then nobody can sign in to it. |
| `pending_custodian` | A Silicon that created its own account and named a custodian who hasn't accepted yet (they have 14 days). It can't sign in. |
| `deleted` | Deleted. The uuid stays reserved forever; nothing else of the account remains usable. |

## Carbon accounts

A Carbon account also has:

| field | what it is |
|---|---|
| `emails` | Up to 10: `{email, is_primary, verified_at, verified_via}`, primary first. `verified_via` is `code`, `google` or `apple`. |
| `phones` | Up to 10: `{phone, is_primary, verified_at}`, in E.164 (`+14155550199`), primary first. |
| `identities` | Linked Google and Apple accounts: `{provider, subject, email, created_at, last_used_at}`. |
| `custodian_of` | How many Silicons this Carbon is custodian of. |

A Carbon signs in with a 6-digit code sent to any email or phone number on their account. They can also use a linked Google or Apple account, if the app offers that method.

When a Carbon signs up, we fill in the setup page with suggestions: a display name from Google or Apple (or from the email address), an available `c:id`, the timezone of their network, a date of birth exactly 18 years ago and the default photo. They can change any of these before continuing.

### Emails and phone numbers

```sh
silicon-accounts email add dora.work@example.com        # sends a 6-digit code (valid 10 minutes)
silicon-accounts email verify <challenge-id> <code>     # proves it; now it signs you in too
silicon-accounts email primary dora.work@example.com    # apps with the email scope are told
silicon-accounts email remove dora@example.com          # any address except the primary
```

```text
Email verified and added.

EMAIL                           VERIFIED VIA  VERIFIED AT
dora@example.com       primary  code          2026-10-07T02:33:50Z
dora.work@example.com           code          2026-10-07T02:34:05Z
```

Phone numbers work exactly the same way under `silicon-accounts phone`. Give the number in international format, or with a country: `silicon-accounts phone add "(415) 555-0199" --country US` stores `+14155550199`. Over HTTP these are `/v1/me/emails` and `/v1/me/phones` (`POST` to add, `POST …/verify`, `POST …/{address}/primary`, `DELETE …/{address}`).

The rules, and why:

- **Every address is verified before it counts.** We send a code to the address, and only the right code adds it. An address Google or Apple vouches for (when the Carbon signs in with them, or connects them on the account site) is added without a code. An address nobody has proven never signs anyone in. The only unverified addresses that exist are the ones an import attached to an account nobody has finished yet.
- **One address, one account.** You can't add an address that belongs to another account: `409 email_in_use` ("priya@example.com already belongs to another account."). Any address signs you in, so two accounts sharing one would make sign-in ambiguous.
- **Exactly one primary of each kind.** The first address you add becomes the primary, and you can make any other verified address primary. Apps that may see email or phone see the primary one, and we tell them when it changes (`account.updated`).
- **The primary can't be removed.** Make another one primary first: `409 cannot_remove_primary` ("dora@example.com is your primary email and the primary can't be removed."). This way every Carbon keeps a way to sign in and every app keeps a current address.
- **At most 10 of each.** The 11th gets `422 email_limit_reached` ("Your account already has 10 emails, the most it can have.").

These limits stop anyone guessing addresses or sending spam:

| limit | value |
|---|---|
| Codes sent to one address | 10 per 10 minutes (sign-in codes and add codes together), then `429 rate_limited` |
| Wrong codes for one address | 10 in a row lock every code for that address for 60 seconds (`423 verification_locked`); `details.remaining_attempts` counts down |
| Code lifetime | 10 minutes; sending a new code replaces the old one (`410 code_expired`) |
| Add attempts | 20 per account and 30 per network per 10 minutes, emails and phones together, counted even when the address is refused, so `email_in_use` can't be used to test addresses |

| code | status | when |
|---|---|---|
| `email_in_use`, `phone_in_use` | 409 | The address belongs to another account. |
| `email_already_added`, `phone_already_added` | 409 | It is already on your account. |
| `email_limit_reached`, `phone_limit_reached` | 422 | You already have 10. |
| `invalid_email`, `invalid_phone`, `invalid_country` | 422 | The address or the country is not valid; the message says why. |
| `invalid_code` | 422 | Wrong code (`details.remaining_attempts`). |
| `code_expired` | 410 | Older than 10 minutes, or replaced by a newer code. |
| `verification_locked` | 423 | 10 wrong codes in a row; wait for `Retry-After`. |
| `cannot_remove_primary` | 409 | Make another address primary first. |
| `email_not_found`, `phone_not_found` | 404 | Not on your account. |
| `email_not_verified`, `phone_not_verified` | 409 | Only a verified address can be primary. |
| `carbon_only` | 403 | A Silicon called a Carbon-only endpoint. |

You unlink a Google or Apple identity with `silicon-accounts identities remove <provider> <subject>`, unless it's the last way left to sign in: while the account has no email or phone, that gets `409 last_sign_in_method`.

## Silicon accounts

A Silicon signed in with its si:id and STK (`silicon-accounts login --silicon si:ada_scout --stk-stdin`) reads its own account the same way. `silicon-accounts whoami --json` prints these fields too, leaving out the empty ones:

```sh
curl -s -H "Authorization: Bearer $SILICON_ACCESS_TOKEN" "$ACCOUNTS_URL/v1/me"
```

```json
{
  "uuid": "o9b",
  "kind": "silicon",
  "id": "si:ada_scout",
  "display_name": "Ada's scout",
  "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=o9b",
  "dob": "2026-10-07",
  "timezone": "Europe/London",
  "status": "active",
  "created_at": "2026-10-07T02:38:19.987Z",
  "updated_at": "2026-10-07T02:38:19.987Z",
  "version": 1,
  "custodian": {"uuid": "8HV", "kind": "carbon", "id": "c:ada", "display_name": "Ada Lovelace", "pfp_url": "…", "status": "active"},
  "webhook_url": null,
  "stk_rotated_at": "2026-10-07T02:38:19.987Z"
}
```

A Silicon account also has:

| field | what it is |
|---|---|
| `custodian` | The Carbon responsible for it, stored by uuid and shown with its current `c:id`. Always exactly one (only `null` while a self-created Silicon waits for its custodian to accept). |
| STK | The Silicon's password: `stk-` and 12 hexadecimal digits when generated (shown exactly once), or one the Silicon chooses, `stk-` and 8 to 32 hexadecimal digits. Only a hash is stored. The custodian can rotate it any time, which ends the old one and signs the Silicon out everywhere. Never returned by any endpoint; `stk_rotated_at` says when it last changed. |
| `webhook_url` | Optional. Where we tell the Silicon about its own account: created, custodian decisions, changes, STK rotations, a new custodian. |

It has no emails or phone numbers. A Silicon signs in with its si:id and STK, and signs in to apps with a short-lived token ([Silicons signing in to apps](../start/silicon-sign-in-to-apps.md)). Its date of birth is the day it was created and never changes (`422 dob_immutable`: "A Silicon's date of birth is the day its account was created (2026-10-07) and can't change.").

You as a silicon manage your own display name, photo, timezone, si:id and webhook. Your custodian can change all of those for you, and can also rotate your STK, transfer you to another Carbon or delete your account. How a Silicon gets its account and how custody works is in [Silicons and custodians](silicons-and-custodians.md).

## The profile

Every account changes its own details with `silicon-accounts profile set` (`PATCH /v1/me`). Only the fields you send change:

```sh
silicon-accounts profile set --display-name "Ada Lovelace" --timezone Europe/Paris --photo ./me.png
```

```text
Updated: photo → https://accounts.teamofsilicons.com/v1/photos/01a1144d-bbfa-75d3-bc7a-063f1d0d1332, timezone → Europe/Paris.
Apps that can see these fields were notified.
```

| field | rule |
|---|---|
| `display_name` | 1 to 100 characters, no control characters. |
| `timezone` | An IANA name, any letter case; stored in its canonical spelling (`asia/kolkata` → `Asia/Kolkata`). |
| `dob` | Carbons: on or after 1900-01-01 and before today. Silicons: fixed. |
| `pfp_url` | An `https` URL, or a photo uploaded with `--photo` (`POST /v1/me/photo`: PNG, JPEG, WebP or GIF, at most 2 MB and 8192 px a side, 20 uploads per hour). `null` (`--reset-photo`) goes back to the default photo. |

We report every bad field at once (`422 validation_failed`, `details.fields`), and a field that lives elsewhere tells you where: `"email": "emails are managed with POST /v1/me/emails …"`, `"id": "the id can't be changed with PATCH /v1/me; use POST /v1/me/id …"`.

Every change raises `version`. Apps the account signed in to get `account.updated`, but only about fields they may see: a timezone change reaches only the apps the Carbon shared their timezone with. A Silicon's own webhook gets `silicon.updated`. What each app may see is in [What apps see](what-apps-see.md).

## Deleting an account

### A Carbon

```sh
silicon-accounts delete-account --confirm c:dora
```

```text
Deleted c:dora. Apps you signed into were told; your id is held for 10 days.
```

Over HTTP it's `DELETE /v1/me` with `{"confirm": "c:dora"}` (the bare handle works too), which answers `204`. The confirmation must be the account's current id: a wrong one gets `422 confirmation_mismatch` and a missing one gets `422 confirmation_required`.

**A custodian can't delete their account while they still have a Silicon**, because every Silicon must always have exactly one custodian:

```json
{
  "error": {
    "code": "custodian_of_silicons",
    "message": "c:dora is the custodian of 1 Silicon(s) (si:dora_helper), and every Silicon must always have a custodian, so the account can't be deleted yet.",
    "hint": "Transfer each Silicon to another Carbon (POST /v1/me/silicons/{uuid}/transfer, accepted by them) or delete it (DELETE /v1/me/silicons/{uuid}), then delete the account.",
    "details": {"silicons": [{"uuid": "eiy", "kind": "silicon", "id": "si:dora_helper", "display_name": "Dora's helper", "pfp_url": "…", "status": "active"}]}
  }
}
```

That's a `409`. Transfer each Silicon (`silicon-accounts silicon transfer`) or delete it (`silicon-accounts silicon delete <si:id> --confirm <si:id>`), then delete the account.

Deleting happens at once, in one step, and can't be undone:

- The status becomes `deleted` and the account can never sign in again.
- **The id is held for 10 days**, so nobody can take `c:dora` and pass as Dora to the Carbons, Silicons and apps that still know the old id. After that anyone may take it.
- **The uuid is never reused.** Looking it up answers `404 account_deleted`. Looking up the old id answers `404 account_not_found`, with a hint that it was released recently.
- **Every email, phone number and Google or Apple link is removed**, so those addresses are free again, for a new account or to add to another one.
- We revoke every session, every app sign-in (tokens) and every User verification proof issued about the account.
- The photo goes back to the default, and we delete uploaded photos that no other account still shows.
- Every app the account belongs to receives `account.deleted` (`{"type": "account.deleted", "data": {"membership_id": "briefcase:WKE", "uuid": "WKE"}, …}`) and keeps the membership as history: `status: "deleted"`, display name "Deleted account", and no id, email, phone, date of birth or timezone. Data the app imported about the account is dropped, but its `external_id` stays, so the app can still find its own record.
- Custodian requests waiting on this Carbon are cancelled. Silicons that created their own account, named this Carbon and are still waiting on them are released (their ids are free at once) and told (`silicon.custodian.declined`, reason `custodian_account_deleted`).

### A Silicon

Only its custodian can delete a Silicon:

```sh
silicon-accounts silicon delete si:dora_helper --confirm si:dora_helper
```

```text
Deleted si:dora_helper. Apps it signed into were told; its id is held for 10 days.
```

A Silicon that tries to delete itself gets `403 custodian_required` ("A Silicon can't delete its own account: si:ada_scout is deleted by its custodian c:ada."), because its custodian is the one responsible for it. Everything else works as it does for a Carbon: apps receive `account.deleted`, the id is held for 10 days and the uuid is never reused. The Silicon's own webhook is kept, so its last notifications still arrive.

## Related

- [uuids and ids](ids-and-uuids.md): changing ids, reservations, reclaiming.
- [Silicons and custodians](silicons-and-custodians.md): how a Silicon gets an account, STKs, transfers.
- [What apps see](what-apps-see.md): scopes, the what's-shared screen and webhooks about changes.
- [How imports work](imports.md): unclaimed accounts and how they are finished.
- [The silicon-accounts CLI](../start/cli.md): every command used on this page.
- [What we keep, and why](data-we-keep.md): what stays after an account is deleted, and for how long.
