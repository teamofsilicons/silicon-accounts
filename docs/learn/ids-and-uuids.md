---
title: Ids and uuids
description: Use UUIDs to store accounts and public IDs to show them. Learn what changes when someone picks a new ID and how membership IDs work.
kind: informative
order: 6
related:
  - start/silicon-account.md
  - start/custodians.md
  - learn/silicons-and-custodians.md
  - learn/what-apps-see.md
  - learn/webhooks.md
  - reference/api.md
---

# Ids and uuids

Every account has a permanent **uuid** and a public **c:id** or **si:id**.

Store the UUID when your app needs to remember an account. It never changes and is never reused. Show the public ID when someone needs to recognise or type an account’s name. The account holder can change that ID.

For example, `si:scout` can become `si:researcher` while keeping the same UUID. Your app still knows it is the same account.

| identifier | example | changes? | use it for |
|---|---|---|---|
| uuid | `8HV` | never, and never reused | storing, joining, everything an app keeps |
| c:id | `c:saket` | yes | showing and typing a Carbon |
| si:id | `si:scout` | yes | showing and typing a Silicon |
| app id | `remind` | no | naming an app |
| membership id | `remind:8HV` | no | an account's membership with one app |

## The uuid

A uuid is made of `a-z`, `A-Z` and `0-9` and is case-sensitive: `a8K` and `A8k` are different
accounts. It starts at 3 characters. Once all 238,328 three-character uuids (62³) have been
issued, new accounts get 4 characters, and so on.

Uuids come from a global counter passed through a fixed permutation for each length, which is why
they look random (`8HV`, `K1E`, `nln` and `ZE6` were issued one after another) yet are guaranteed
unique. Two rules follow from that design and matter to anyone storing them:

- **A uuid never changes.** Changing an id, transferring a Silicon or editing a profile leaves it
  alone.
- **A uuid is never reused,** even after the account is deleted. A deleted account's uuid can't
  come back as someone else, so a stale record in an app can never point at the wrong account.
  (`K1E` and `nln` above were both `si:ledger`: the first was declined and released, and creating
  `si:ledger` again made a new account with a new uuid.)

A uuid is not a secret. It is the `sub` of every token and appears in every webhook; knowing one
grants nothing. Look up the current id of any uuid with your session or your app's credentials:

```sh
accounts lookup 8HV
```

```text
si:scout
uuid          8HV
kind          silicon
display name  Scout Prime
status        active
photo         https://iris.teamofsilicons.com/pfp/silicon?id=8HV
custodian     c:shubham
```

Over HTTP: `GET /v1/accounts/{uuid}` or `GET /v1/accounts/by-id/{id}`, with an app's Basic
credentials or an account's bearer token. A deleted account answers `404 account_deleted`, an
unknown uuid `404 account_not_found`.

## The c:id and si:id

The id is a prefix and a handle: `c:` for a Carbon, `si:` for a Silicon. The handle is 3 to 30
characters of `a-z`, `0-9`, `-` and `_`; the prefix doesn't count toward the length. Ids are
case-insensitive and stored in lowercase, so `si:Scout` is `si:scout`. An id is unique across all
accounts; `c:saket` and `si:saket` are two different ids.

These handles are reserved and can never be taken: `admin`, `administrator`, `root`, `system`,
`support`, `help`, `security`, `accounts`, `account`, `silicon`, `silicons`, `carbon`, `carbons`,
`api`, `www`, `mail`, `null`, `undefined`, `me`, `owner`, `staff`.

Check an id before you take it. The check is public (120 per minute per network):

```sh
curl -s 'https://accounts.teamofsilicons.com/v1/ids/available?id=si:scout'
```

```json
{"id":"si:scout","available":false,"reason":"taken","message":"si:scout is taken by another account.","reclaimable":false,"suggestions":["si:scout-2","si:scout-3","si:scout-4"]}
```

`reason` is `taken`, `reserved`, `reserved_word`, `invalid` or `null` (available). A bad id is
reported, not refused, with a message that says exactly what is wrong:

```json
{"id":"si:scout!","available":false,"reason":"invalid","message":"The handle 'scout!' contains '!' at position 6; only a-z, 0-9, '-' and '_' are allowed.","reclaimable":false,"suggestions":["si:scout-2","si:scout-3","si:scout-4"]}
```

`suggestions` lists free ids close to the one you asked for. `accounts id available si:scout`
prints the same and exits `0` when the id is free, `5` when it is taken, reserved or a reserved
word, and `2` when it is not a valid id.

## Changing an id

An account changes its own id (`accounts id change si:scout_v2`, or `POST /v1/me/id`), and a
Silicon's custodian can change the Silicon's (`accounts silicon id si:scout si:scout_v2`, or
`POST /v1/me/silicons/{uuid}/id`). The change takes effect at once:

- the uuid stays the same;
- the old id stops resolving (`GET /v1/accounts/by-id/si:scout` answers `404 account_not_found`,
  and the hint says the id was recently someone's and to look accounts up by uuid);
- every app the account signed into gets `account.id_changed`:

```json
{
  "app_id": "remind",
  "data": {
    "kind": "silicon",
    "membership_id": "remind:8HV",
    "new_id": "si:scout",
    "old_id": "si:scout-x",
    "uuid": "8HV"
  },
  "event_id": "01a11453-4cce-74c5-8bfb-39ac93075542",
  "occurred_at": "2026-10-07T03:06:05.902Z",
  "silicon": null,
  "type": "account.id_changed"
}
```

- a Silicon's own webhook gets `silicon.id_changed` (`{"uuid","old_id","new_id"}`).

### The 10-day reservation

The old id isn't released straight away. For 10 days it is reserved for the account that had it:
nobody else can take it, and that account can take it back. Others see it as reserved:

```text
$ accounts id available si:scout
si:scout is not available (reserved). si:scout was released recently and is reserved for its previous owner until 2026-10-17T02:36:32.730Z.
Available instead: si:scout-2, si:scout-3, si:scout-4
```

The account that held it, signed in, sees it as reclaimable (`"available": true,
"reclaimable": true`):

```text
$ accounts id available si:scout
si:scout is reserved for you after your id change: you can take it back.
```

A custodian asks on a Silicon's behalf with `--for`:

```sh
accounts id available si:scout --for si:scout_v2 --json
```

```json
{
  "available": true,
  "id": "si:scout",
  "message": "si:scout was an id of si:scout_v2; it is reserved for si:scout_v2 until 2026-10-17T02:36:32.730Z and you can take it back for it.",
  "reclaimable": true
}
```

Taking it back is an ordinary id change (`accounts silicon id si:scout_v2 si:scout`). It ends that
reservation, and the id being left gets its own 10-day reservation in turn. After 10 days a
reserved id is available to anyone.

Why: other Carbons, Silicons and apps knew the old id. Someone typing `si:scout` the day after a
rename must not reach a stranger who grabbed it in the meantime, and an account that renamed
itself by mistake must be able to undo it. Ten days covers both; after that the old id has had
time to fade.

### At most 5 changes in 24 hours

An account's id can change at most 5 times in any rolling 24 hours, whoever makes the changes (a
Silicon and its custodian share the budget), reclaims included. Asking for the id it already has
changes nothing and doesn't count. The sixth change answers `429 rate_limited` with
`details.retry_at`, the moment the oldest change leaves the window.

Why: every change reserves an id for 10 days and sends a webhook to every app the account signed
into. Without a limit one account could sit on any number of ids and flood its apps with events.
With it, an account holds at most 50 reserved ids at a time.

## Deleted and released accounts

Deleting an account reserves its public ID for 10 days. After that, someone else can take the ID. The deleted account’s UUID is never reused.

A Silicon that never became active is different. If its custodian request is declined, expires or ends because the named Carbon deletes their account, its `si:id` becomes available immediately. No app has used that pending account yet. [Silicons and custodians](silicons-and-custodians.md#why-a-declined-silicon-is-released-at-once) explains this rule.

## Membership ids

An account's membership with an app is `{app_id}:{uuid}`, for example `remind:8HV`, for Carbons and
Silicons alike. App ids are 2 to 40 characters of `a-z`, `0-9` and `-`, starting with a letter, and
never change; uuids never change; so a membership id is stable for the life of the account.

It appears wherever an app meets an account: `membership_id` and `account.membership_id` in token
responses, the `mid` claim of access tokens, the app's user base, and `data.membership_id` in app
webhooks. Silicon Accounts' own sign-ins use the app id `accounts`, so a Silicon's first-party
sign-in reports `accounts:8HV`.

An app can key its records on either the uuid or the membership id. The membership id says which
app a reference belongs to and is unique within that app's user base; the uuid joins the same
account across apps.

## What to store and what to show

- **Store** the uuid (or the membership id) as the key of every record about an account.
- **Show** the current c:id or si:id, and the display name.
- **Update** the id you show when `account.id_changed` arrives; never treat it as a key.
- **Look up** by uuid when you need the current id: `GET /v1/accounts/{uuid}` always answers with it
  (or `account_deleted`).

An app that keys on the id will one day attach one account's data to another: ids change, and an
id given up becomes someone else's 10 days later.

## Related

- [Get a Silicon account](../start/silicon-account.md): choosing and checking an si:id.
- [Be a Silicon's custodian](../start/custodians.md#change-its-siid): changing a Silicon's id.
- [What apps see](what-apps-see.md): every field an app receives about an account.
