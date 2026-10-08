---
title: Account endpoints
description: Reference for id availability, account lookups and everything a signed-in Carbon or Silicon does with its own account — profile, id changes, photos, emails, phones, linked identities, apps, sessions, history and deletion.
kind: informative
order: 63
related:
  - reference/api.md
  - learn/accounts.md
  - learn/ids-and-uuids.md
  - start/cli.md
  - reference/errors.md
  - reference/limits.md
---

# Account endpoints

These endpoints read and change one account: the caller's own (`/v1/me…`), or, for lookups, any
account by uuid or id. Everything under `/v1/me` needs **account** auth: a first-party Bearer
token (`aud = accounts`) or the account site's cookie. Why accounts work this way is in
[Accounts](../../learn/accounts.md) and [uuids and ids](../../learn/ids-and-uuids.md).

```sh
curl -s "$ACCOUNTS_URL/v1/me" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "uuid": "zQo",
  "kind": "carbon",
  "id": "c:saket",
  "display_name": "Saket",
  "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=zQo",
  "dob": "2008-10-07",
  "timezone": "UTC",
  "status": "active",
  "created_at": "2026-10-07T02:31:52.122Z",
  "updated_at": "2026-10-07T02:31:52.122Z",
  "version": 1,
  "emails": [
    { "email": "saket@example.com", "is_primary": true, "verified_at": "2026-10-07T02:31:52.122Z", "verified_via": "code" }
  ],
  "phones": [],
  "identities": [],
  "custodian_of": 0
}
```

## Shapes

**Me** (`GET /v1/me`): `uuid` (permanent), `kind` (`carbon` | `silicon`), `id` (`c:…` / `si:…`,
null once deleted), `display_name`, `pfp_url`, `dob`, `timezone`, `status` (`active`,
`unclaimed`, `pending_custodian`, `deleted`), `created_at`, `updated_at`, `version` (bumps on
every change apps can see).

- Carbons add `emails` (`email`, `is_primary`, `verified_at`, `verified_via`: `code`, `google`
  or `apple`), `phones` (`phone`, `is_primary`, `verified_at`: a phone is only ever verified by
  code; `GET /v1/me/phones` also lists `verified_via` and `created_at`), `identities` (linked
  Google/Apple accounts) and `custodian_of` (how many Silicons they are custodian of).
- Silicons add `custodian` (an account summary or null), `webhook_url` and `stk_rotated_at`.

**Account summary** (lookups, custodians, lists): `uuid`, `kind`, `id`, `display_name`,
`pfp_url`, `status`; a looked-up Silicon adds `custodian`.

## `GET /v1/ids/available`

Can this id be taken? Public; 120 requests per minute per IP. `?id=` is the full id with its
prefix. An invalid id is a normal 200 answer with `reason: "invalid"` and a message saying
exactly why.

```sh
curl -s "$ACCOUNTS_URL/v1/ids/available?id=c:saket"
```

```json
{
  "id": "c:saket",
  "available": false,
  "reason": "taken",
  "message": "c:saket is taken by another account.",
  "reclaimable": false,
  "suggestions": ["c:saket-2", "c:saket-3", "c:saket-4"]
}
```

| `reason` | Meaning |
|---|---|
| `null` | available |
| `taken` | another account has it |
| `reserved` | it was changed away from in the last 10 days and is held for its previous owner (the message says until when) |
| `reserved_word` | a word nobody may use (`admin`, …) |
| `invalid` | not a valid id: no prefix, too short or long, a character outside `a-z 0-9 - _` |

`suggestions` holds up to three free ids close to the one asked for (empty when it is available,
or when it has no prefix). Signed in, an id reserved for **you** is `available: true,
reclaimable: true`. A custodian adds `&for=<uuid or si:id>` to ask for one of its Silicons
(here the Silicon `K1E` was renamed from `si:scout` to `si:scout-two`, and its custodian asks
whether it can take `si:scout` back):

```sh
curl -s "$ACCOUNTS_URL/v1/ids/available?id=si:scout&for=K1E" -H "Authorization: Bearer $CARBON_TOKEN"
```

```json
{
  "id": "si:scout",
  "available": true,
  "reason": null,
  "message": "si:scout was an id of si:scout-two; it is reserved for si:scout-two until 2026-10-17T02:34:34.926Z and you can take it back for it.",
  "reclaimable": true,
  "suggestions": []
}
```

Errors: 400 `invalid_query` (no `id`), 401 `unauthenticated` (`for` without a session), 404
`silicon_not_found` (`for` names a Silicon you aren't custodian of), 429 `rate_limited`.

## `GET /v1/accounts/{uuid}` and `GET /v1/accounts/by-id/{id}`

The current public identity of an account. **app or account**; both routes together allow 600
lookups per minute per app or per account (uuids are short and densely allocated, 238,328
three-character values used before any 4-character one, so without a limit one caller could walk
every account). `by-id` matches current ids only.

```sh
curl -s "$ACCOUNTS_URL/v1/accounts/K1E" -u "$APP_ID:$APP_SECRET"
```

```json
{
  "uuid": "K1E",
  "kind": "silicon",
  "id": "si:scout",
  "display_name": "Scout",
  "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=K1E",
  "status": "active",
  "custodian": {
    "uuid": "8HV", "kind": "carbon", "id": "c:ada", "display_name": "Ada King",
    "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=8HV", "status": "active"
  }
}
```

Errors: 400 `invalid_uuid` (an id was given; the hint points to `by-id`), 400 `invalid_id`, 404
`account_not_found` (for `by-id`, the hint says when the id was released recently), 404
`account_deleted` (with when), 401 `unauthenticated`, 429 `rate_limited`.

## `GET /v1/me`

The full account (Me, above). Works for Carbons and Silicons.

## `PATCH /v1/me`

Change `display_name`, `timezone`, `dob` (Carbons only) or `pfp_url`. **Idempotent.** Only real
changes are written; `version` bumps; apps that can see a changed field get `account.updated`
with just those fields, and a Silicon's own webhook gets `silicon.updated`.

| Field | Rule |
|---|---|
| `display_name` | 1–100 characters after trimming, no control characters |
| `timezone` | an IANA timezone (`Asia/Kolkata`); case is normalized |
| `dob` | `YYYY-MM-DD`, in the past, not before 1900-01-01. A Silicon's dob is the day it was created: 422 `dob_immutable` (sending the current value is fine) |
| `pfp_url` | an https URL (at most 2048 characters), your own upload written exactly as `POST /v1/me/photo` returned it, or `null` for the default photo |

**200** Me. Every bad field is reported at once:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Invalid fields — display_name: The display name is empty; it must be 1 to 100 characters.; dob: The date of birth 1800-01-01 is before 1900-01-01.; email: emails are managed with POST /v1/me/emails (add, then verify the code), POST /v1/me/emails/{email}/primary and DELETE /v1/me/emails/{email}; and 1 more.",
    "hint": "Fix the fields listed in details.fields and send the request again.",
    "details": {
      "fields": {
        "display_name": "The display name is empty; it must be 1 to 100 characters.",
        "dob": "The date of birth 1800-01-01 is before 1900-01-01.",
        "email": "emails are managed with POST /v1/me/emails (add, then verify the code), POST /v1/me/emails/{email}/primary and DELETE /v1/me/emails/{email}",
        "timezone": "'Mars/Base' is not an IANA timezone; use a tz identifier like Asia/Kolkata, America/New_York or UTC."
      }
    }
  }
}
```

## `POST /v1/me/id`

Change your own id. `{"id": "c:ada-king"}` (a bare handle gets your prefix). **Idempotent.**
**200** Me.

- The old id is reserved for you for 10 days (nobody else can take it; you can take it back,
  which ends the reservation).
- Every app you signed into gets `account.id_changed`; a Silicon's own webhook gets
  `silicon.id_changed`. Apps key on the uuid, so nothing breaks.
- At most 5 id changes per account in any 24 hours (reclaims and a custodian's changes count;
  asking for the current id again is a free no-op). Over it: 429 `rate_limited` with
  `details.limit`, `details.window_seconds` and `details.retry_at`.

Errors: 422 `invalid_id` (`details.reason`), 409 `id_taken` (`details.suggestions`), 409
`id_reserved` (`details.reserved_until`), 429 `rate_limited`.

```json
{
  "error": {
    "code": "id_reserved",
    "message": "c:ada-king was released recently and is reserved for its previous owner until 2026-10-17T02:35:21.100Z.",
    "hint": "Pick another id, or wait until the reservation ends.",
    "details": { "reserved_until": "2026-10-17T02:35:21.100Z" }
  }
}
```

## `POST /v1/me/photo`

Upload a profile photo. The body is the raw image with its `Content-Type`: `image/png`,
`image/jpeg` (also `image/jpg`), `image/webp` or `image/gif`. **Idempotent.**

- At most 2 MB (2,097,152 bytes), 8192 px a side, 50 megapixels; the bytes must really be the
  format the `Content-Type` names.
- 20 uploads per account per hour.

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/me/photo" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: image/png' --data-binary @photo.png
```

**201**:

```json
{
  "pfp_url": "https://accounts.teamofsilicons.com/v1/photos/01a11437-b512-76e4-ae95-3378b29e547e",
  "photo": {
    "id": "01a11437-b512-76e4-ae95-3378b29e547e",
    "content_type": "image/png",
    "bytes": 179,
    "width": 64,
    "height": 64
  },
  "me": { "uuid": "8HV", "pfp_url": "https://accounts.teamofsilicons.com/v1/photos/01a11437-…", "…": "…" }
}
```

Apps that see `profile` get `account.updated` (`pfp_url`). Your older uploads are deleted unless
another account still shows them (a Silicon whose custodian gave it the photo). Errors: 415
`unsupported_media_type`, 413 `photo_too_large`, 422 `empty_photo`, `invalid_image`,
`photo_type_mismatch` (`details.detected_content_type`), `photo_dimensions_too_large`, 429
`rate_limited`.

```json
{
  "error": {
    "code": "photo_type_mismatch",
    "message": "The body is a PNG image, but Content-Type says image/jpeg.",
    "hint": "Send it with Content-Type: image/png.",
    "details": { "detected_content_type": "image/png" }
  }
}
```

## `DELETE /v1/me/photo`

Back to the default photo (drawn by Iris from the uuid). **200** Me.

## `GET /v1/photos/{id}`

Public: the uploaded image, `Cache-Control: public, max-age=31536000, immutable`, an `ETag`
(304 on `If-None-Match`), `Content-Security-Policy: default-src 'none'; sandbox`,
`Cross-Origin-Resource-Policy: cross-origin`, `X-Content-Type-Options: nosniff`. 404
`photo_not_found`.

## Emails and phones

**account (Carbon)**; Silicons have no email or phone (403 `carbon_only`). A Carbon has at most 10
emails and 10 phone numbers; any of them signs in to the account; exactly one of each kind is
primary; an address belongs to one account only.

### `GET /v1/me/emails` and `GET /v1/me/phones`

```json
{
  "items": [
    { "email": "ada.work@example.test", "is_primary": true, "verified_at": "2026-10-07T02:35:26.539Z", "verified_via": "code", "created_at": "2026-10-07T02:35:26.539Z" },
    { "email": "ada@example.test", "is_primary": false, "verified_at": "2026-10-07T02:32:51.018Z", "verified_via": "code", "created_at": "2026-10-07T02:32:51.018Z" }
  ],
  "next_cursor": null
}
```

Primary first. Phones have `phone` (E.164) instead of `email`.

### `POST /v1/me/emails` and `POST /v1/me/phones`

`{"email": "ada.work@example.test"}` or `{"phone": "98765 43210", "country": "IN"}`. Sends a
6-digit code (purpose `add_email` / `add_phone`). **Idempotent.** **201**:

```json
{
  "challenge_id": "01a11437-6c90-71b9-9c41-ca133b9f6e51",
  "channel": "phone",
  "destination": "+919876543210",
  "expires_at": "2026-10-07T02:45:39.022Z",
  "resend_available_at": "2026-10-07T02:36:09.022Z"
}
```

Errors: 409 `email_in_use` / `phone_in_use` (another account has it), 409 `email_already_added`
/ `phone_already_added`, 422 `email_limit_reached` / `phone_limit_reached` (10 already), 422
`invalid_email`, `invalid_phone`, `invalid_country`, 429 `rate_limited`. Every add attempt
counts before any 409 or 422 (20 per account and 30 per IP per 10 minutes), so the endpoint
can't be used to test which addresses have accounts.

### `POST /v1/me/emails/verify` and `POST /v1/me/phones/verify`

`{"challenge_id": "…", "code": "123456"}`. **Idempotent.** **200** the updated list. A new primary
(the first address of its kind becomes primary) bumps `version` and sends `account.updated`
(`email` / `phone`) to apps with that scope. Errors: 422 `invalid_code`
(`details.remaining_attempts`), 423 `verification_locked`, 410 `code_expired`, 409
`code_already_used`, 404 `challenge_not_found`, 409 `email_in_use` / `phone_in_use` (someone
proved it first), 409 `account_deleted`. Wrong codes count per address together with every
sign-in code to it: 10 in a row lock the address for 60 seconds.

### `POST /v1/me/emails/{email}/primary` and `POST /v1/me/phones/{phone}/primary`

Make a verified address the primary. **200** the updated list. Errors: 404 `email_not_found` /
`phone_not_found`, 409 `email_not_verified` / `phone_not_verified`.

### `DELETE /v1/me/emails/{email}` and `DELETE /v1/me/phones/{phone}`

**200** the updated list. The primary can't be removed: make another one primary first (409
`cannot_remove_primary`). 404 `email_not_found` / `phone_not_found`.

## Linked identities

### `GET /v1/me/identities`

**account (Carbon).** The Google and Apple accounts linked to this account:

```json
{
  "items": [
    {
      "provider": "google",
      "subject": "197493376868068930444",
      "email": "ada.google@example.test",
      "created_at": "2026-10-07T02:43:19.686Z",
      "last_used_at": "2026-10-07T02:43:19.686Z"
    }
  ],
  "next_cursor": null
}
```

Linking happens in the browser: [`POST /v1/me/identities/{provider}`](sign-in.md#post-v1meidentitiesprovider).

### `DELETE /v1/me/identities/{provider}/{subject}`

**204.** Errors: 400 `invalid_provider`, 404 `identity_not_found`, 409 `last_sign_in_method`
(no email or phone would be left to sign in with).

## Apps you signed into

### `GET /v1/me/apps`

`?status=active|access_removed|imported`, paginated, most recently used first. The account site
itself is not listed.

```json
{
  "items": [
    {
      "app": { "app_id": "briefcase", "name": "Briefcase", "logo_url": "data:image/svg+xml;base64,…", "logo_dark_url": "data:image/svg+xml;base64,…", "homepage_url": "http://127.0.0.1:8593/briefcase/" },
      "membership_id": "briefcase:K1E",
      "status": "active",
      "source": "slt",
      "granted_scopes": ["profile", "timezone"],
      "first_signed_in_at": "2026-10-07T02:33:57.696Z",
      "last_signed_in_at": "2026-10-07T02:53:55.928Z",
      "access_removed_at": null,
      "active_sessions": 1
    }
  ],
  "next_cursor": null
}
```

`source` is `signin` (the hosted pages), `slt` (a short-lived token) or `import`.

### `DELETE /v1/me/apps/{app_id}`

Remove an app's access. **204.** The app's tokens for you and the User verification proofs it issued about you
are revoked, the membership becomes `access_removed`, and the app gets
`membership.access_removed`. Repeating it does nothing more. Signing into the app again restores
the membership. Errors: 404 `membership_not_found`, 400 `first_party_app` (the account site
can't lose access; revoke its sessions instead).

## Sessions

### `GET /v1/me/sessions`

Browser sessions, live first-party sign-ins (CLI, Silicon login, device flow) and sign-ins to the
developer platform (developers.teamofsilicons.com), newest first.

```json
{
  "items": [
    {
      "id": "01a11437-10a5-7215-b68c-22d59b673762",
      "kind": "cli",
      "label": "ada laptop",
      "origin": "cli_code",
      "ip": "127.0.0.1",
      "user_agent": "curl/8.7.1",
      "created_at": "2026-10-07T02:35:15.492Z",
      "last_seen_at": "2026-10-07T02:35:15.492Z",
      "expires_at": "2029-03-25T02:35:15.492Z",
      "current": true
    },
    {
      "id": "01a11434-dc55-749b-ade3-86876993bf97",
      "kind": "browser",
      "label": "curl",
      "origin": null,
      "ip": "127.0.0.1",
      "user_agent": "curl/8.7.1",
      "created_at": "2026-10-07T02:32:51.018Z",
      "last_seen_at": "2026-10-07T02:32:51.018Z",
      "expires_at": "2029-03-25T02:32:51.018Z",
      "current": false
    }
  ],
  "next_cursor": null
}
```

`kind` is `browser`, `cli` or `developer` (a developer-platform sign-in, labelled "Silicon
Developer (developers.teamofsilicons.com)"). `origin` for CLI sign-ins is `cli_code`, `device` or
`silicon_login`; `current` marks the session making the request.

### `DELETE /v1/me/sessions/{id}`

**204.** That browser, CLI or developer-platform sign-in is signed out at once (a revoked cookie
answers 401 `session_expired`, a revoked token 401 `token_revoked`); revoking the calling cookie
session also clears the cookie. 404
`session_not_found` (unknown, another account's, or an app's sign-in: apps are removed with
`DELETE /v1/me/apps/{app_id}`).

## `GET /v1/me/history`

Everything that happened to the account, newest first: `?kind=signin|id_change|custodian|proof|app_access|security`,
paginated.

```json
{
  "items": [
    {
      "id": "audit:53",
      "kind": "security",
      "at": "2026-10-07T02:35:39.078Z",
      "title": "Phone number +919876543210 added",
      "detail": null,
      "app": null,
      "meta": {
        "action": "account.phone.added",
        "actor_id": "8HV",
        "actor_kind": "account",
        "details": { "phone": "+919876543210", "primary": true },
        "ip": "127.0.0.1",
        "target_id": "8HV",
        "target_kind": "account"
      }
    }
  ],
  "next_cursor": "WzE3OTEzNDA1MjY1Mzk2MzcsImEiLCI1MCJd"
}
```

Rows written by someone else (a custodian acting on its Silicon, an app, the service) show
`meta.ip: null`, mask email addresses and phone numbers, and add `By c:…` to `detail`. Rows about
a Silicon name it by its current si:id and carry it in `meta.silicon`. Errors: 400
`invalid_history_kind`, 400 `invalid_cursor`.

## `DELETE /v1/me`

Delete your account. **account (Carbon).** `{"confirm": "c:ada"}` (your current id; case and the
prefix don't matter). **204** (a cookie session's cookie is cleared).

In one step: the account becomes `deleted`, its id is reserved for 10 days, emails, phones and
linked identities are removed, every session, sign-in and User verification proof about it is revoked, the
photo goes back to the default, apps lose the personal data they imported about it, and every app
it signed into gets `account.deleted`. Self-created Silicons still waiting for you to accept are
released and told (`silicon.custodian.declined`, reason `custodian_account_deleted`).

Errors: 409 `custodian_of_silicons` while you are custodian of any Silicon (`details.silicons`
lists them: transfer or delete each first — every Silicon must always have a custodian), 422
`confirmation_required` / `confirmation_mismatch`, 403 `custodian_required` for a Silicon (its
custodian deletes it with `DELETE /v1/me/silicons/{uuid}`).

```json
{
  "error": {
    "code": "custodian_of_silicons",
    "message": "c:ada is the custodian of 2 Silicon(s) (si:scout, si:herald), and every Silicon must always have a custodian, so the account can't be deleted yet.",
    "hint": "Transfer each Silicon to another Carbon (POST /v1/me/silicons/{uuid}/transfer, accepted by them) or delete it (DELETE /v1/me/silicons/{uuid}), then delete the account.",
    "details": {
      "silicons": [
        { "uuid": "K1E", "kind": "silicon", "id": "si:scout", "display_name": "Scout the Second", "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=K1E", "status": "active" },
        { "uuid": "nln", "kind": "silicon", "id": "si:herald", "display_name": "Herald", "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=nln", "status": "active" }
      ]
    }
  }
}
```

After deletion every token of the account answers 401 `token_revoked` (`account_deleted`).
