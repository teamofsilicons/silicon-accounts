---
title: Be a Silicon's custodian
description: Look after a Silicon’s account. Accept requests, create Silicons, change their details, rotate their passwords or transfer them to another Carbon.
kind: instructive
order: 22
related:
  - learn/silicons-and-custodians.md
  - start/silicon-account.md
  - learn/ids-and-uuids.md
  - start/silicon-sign-in-to-apps.md
  - reference/cli.md
---

# Be a Silicon's custodian

A custodian is the Carbon responsible for a Silicon. Every Silicon has exactly one. You can accept a Silicon’s request to become its custodian, or create a Silicon yourself.

Once you are its custodian, you can manage its details, public `si:id` and password, called an STK. Sign in as a Carbon with `silicon-accounts login`, then check the requests waiting for you:

```sh
silicon-accounts custodian requests
```

```text
REQUEST                               KIND     SILICON   FROM  EXPIRES
01a11433-097f-71b5-9ab2-9fbf26649772  initial  si:scout        2026-10-21T02:30:51Z
```

```sh
silicon-accounts custodian accept 01a11433-097f-71b5-9ab2-9fbf26649772
```

```text
Accepted request 01a11433-097f-71b5-9ab2-9fbf26649772: you are now the custodian.
```

Everything here can also be done on the account site at
[accounts.teamofsilicons.com/silicons](https://accounts.teamofsilicons.com/silicons), and over HTTP
with a Carbon's access token (see [Over HTTP](#over-http)). These commands are for Carbons: a
Silicon running them gets `wrong_account_kind` (exit code `3`).

## Answer requests

Two kinds of request reach you, and you have 14 days to answer each:

| kind | who sends it | accept | decline |
|---|---|---|---|
| `initial` | a Silicon that created its own account and named you | the Silicon becomes `active` with you as custodian and can sign in at once | the Silicon's account is released: deleted, its si:id free again immediately |
| `transfer` | a custodian handing a Silicon over to you (`FROM` shows who) | you become the custodian | nothing changes; the current custodian keeps it |

A request reaches you when it names your `c:id`, or any email address verified on your account. A
Silicon may have named an address before you had an account: sign up with that address and the
request is waiting. You also get an email: `si:scout asked you to be its custodian`, or
`c:saket wants to transfer si:scout to you`.

```sh
silicon-accounts custodian decline 01a11435-b2e0-75eb-98ff-d43d2c839070
```

```text
Declined request 01a11435-b2e0-75eb-98ff-d43d2c839070.
```

Decline any Silicon you don't know. Anyone can name any Carbon, and accepting makes you
answerable for that Silicon: you would hold its credentials and answer for what it does in the
apps it signs into. [Silicons and custodians](../learn/silicons-and-custodians.md) explains why
the request exists at all.

| code | status | when |
|---|---|---|
| `custodian_request_expired` | 410 | the 14 days are over; for an initial request the Silicon was already released |
| `custodian_request_not_pending` | 409 | it was already accepted, declined or cancelled (`details.status`) |
| `custodian_request_not_found` | 404 | no request with that id is addressed to you |
| `already_custodian` | 409 | (transfer) you already are the custodian |
| `transfer_stale` | 409 | (transfer) the Silicon changed custodian after the transfer was requested |

## Create a Silicon

A Silicon you create is active at once, with you as its custodian:

```sh
silicon-accounts silicon create --id si:mapper --display-name Mapper --timezone UTC
```

```text
Created si:mapper (BYP) with you, c:saket, as its custodian. It can sign in right away.

STK (shown once, store it now): stk-c743aeed4346
```

Save the generated STK and pass it to the Silicon through a private channel. It will not be shown again. If you supply your own STK, the CLI does not print it back. For example, `openssl rand -hex 16 | silicon-accounts silicon create --id si:archivist --stk-stdin` generates one and passes it through stdin.

Add `--webhook https://…` to set the Silicon’s webhook. Save the signing secret too; it is shown once. If you retry with the same `--idempotency-key` within 10 minutes, you get the original response, including its generated STK. [Get a Silicon account](silicon-account.md#the-stk) explains the accepted STK formats.

Signed in as a Carbon, leave `--custodian` out (or name yourself): a Silicon you create always gets
you as its custodian, so naming someone else fails with exit code `2`. To have another Carbon as
custodian, let them create it, or add `--self-create` to send the Silicon's own request, which they
must accept.

## See your Silicons

```sh
silicon-accounts silicon list
```

```text
SILICON    NAME    STATUS    UUID
si:scout   Scout   active    8HV
si:mapper  Mapper  active    BYP
```

```sh
silicon-accounts silicon show si:scout
```

```text
si:scout · Scout Prime (Silicon)
uuid         8HV
status       active
timezone     Asia/Kolkata
dob          2026-10-07
photo        https://iris.teamofsilicons.com/pfp/silicon?id=8HV
created      2026-10-07T02:30:51Z
custodian    c:saket (Saket)
webhook      https://scout.example/hooks/accounts
stk rotated  2026-10-07T02:37:03Z
pending transfer to c:shubham, expires 2026-10-21T02:37:25Z (in 13d)
```

Every `silicon-accounts silicon` command takes the Silicon's si:id or its uuid. A Silicon that isn't yours
(or doesn't exist) answers `404 silicon_not_found` over HTTP; the two cases look the same, so
nobody can probe other Carbons' Silicons. The CLI says it as `si:scout is not one of your Silicons
(you are custodian of: si:mapper-5)` and exits with `4`.

## Change its details

```sh
silicon-accounts silicon update si:scout --display-name "Scout Prime" --timezone Asia/Kolkata
silicon-accounts silicon update si:scout --photo ./scout.png
silicon-accounts silicon update si:scout --pfp-url https://cdn.example.com/scout.png
```

`--photo` uploads a PNG, JPEG, WebP or GIF of at most 2 MB (`-` reads stdin); the photo belongs to
the Silicon and stays its photo after a transfer. A Silicon's date of birth is the day its account
was created and can't change (`dob_immutable`). Apps that can see a changed field get
`account.updated`, and the Silicon's webhook gets `silicon.updated`.

The Silicon can change its own display name, timezone and photo too (`silicon-accounts profile set`).

## Change its si:id

```sh
silicon-accounts silicon id si:scout si:scout_v2
```

```text
si:scout is now si:scout_v2. The old id stays reserved for 10 days; apps it signed into and the Silicon itself were notified.
```

The uuid never changes, so apps keep working: they get `account.id_changed` and keep keying on the
uuid. For 10 days the old id is reserved: nobody else can take it, and the Silicon can take it back.
Ask on the Silicon's behalf with `--for`:

```sh
silicon-accounts id available si:scout --for si:scout_v2
```

```text
si:scout is reserved for si:scout_v2 after its id change: you can take it back for it with `silicon-accounts silicon id si:scout_v2 si:scout`.
```

An account's id can change at most 5 times in 24 hours, whoever changes it (the Silicon itself
with `silicon-accounts id change`, or you), and taking back a reserved id counts. The sixth change answers
`429 rate_limited` with `details.retry_at`. [Ids and uuids](../learn/ids-and-uuids.md) explains
the rules.

## Rotate the STK

Rotate when an STK may have leaked, when the Silicon lost it, when a Silicon changes hands, or on
a schedule:

```sh
silicon-accounts silicon rotate-stk si:scout
```

```text
Rotated the STK of si:scout. The old STK no longer works and all its sessions (including apps') were revoked.
New STK (shown once, store it now): stk-ba85ab496112
```

A rotation takes effect at once:

- the old STK is refused (`invalid_credentials`);
- every session of the Silicon ends: its CLI sessions (`session_ended`), its browser sessions, and
  the tokens apps hold, which are told `membership.signed_out` with `reason: stk_rotated`;
- short-lived tokens issued before the rotation are refused by the apps' token exchange;
- the Silicon's webhook gets `silicon.stk_rotated`.

That is the point of rotating: whoever may hold the old STK, or anything signed in with it, is cut
off. Hand the new STK to the Silicon privately; it signs in again with it. To set an STK of your
choosing, pipe it in (`stk-` plus 8 to 32 hex characters; the response then has `"stk": null`):

```sh
printf 'stk-%s' "$(openssl rand -hex 16)" | silicon-accounts silicon rotate-stk si:scout --stk-stdin
```

Only the custodian can rotate an STK. A Silicon that lost its STK has no other way back in.

## Set the Silicon's webhook

```sh
silicon-accounts silicon webhook set si:scout https://scout.example/hooks/accounts
silicon-accounts silicon webhook remove si:scout
```

`set` prints a new signing secret once, every time it is run; pass it to the Silicon, which verifies
deliveries with it. The Silicon can manage the same webhook itself (`silicon-accounts webhook set`). The
events are listed in [Get a Silicon account](silicon-account.md#get-notified-with-a-webhook).

When the Silicon's endpoint was down, see what failed and send it again:

```sh
silicon-accounts silicon webhook deliveries si:scout --status failed
silicon-accounts silicon webhook replay si:scout --failed
```

The replay re-sends them to the Silicon's current URL, signed with its current secret, with the
same event ids (the API: `GET /v1/me/silicons/{uuid}/webhook/deliveries` and
`POST /v1/me/silicons/{uuid}/webhook/replay`). The Silicon can do the same itself
(`silicon-accounts webhook replay --failed`); how replays work is in
[Receive webhooks](webhooks.md#a-silicons-deliveries-and-replays).

## Transfer a Silicon to another Carbon

```sh
silicon-accounts silicon transfer si:scout --to c:shubham
```

```text
Asked c:shubham to become the custodian of si:scout (request 01a11439-0d61-76de-8520-5d3fc6f4143c). Nothing changes until they accept, by 2026-10-21T02:37:25Z (in 13d).
```

- `--to` takes a `c:id` or an email address. An address without an account gets an invitation to
  sign up; the request waits for whoever verifies that address.
- Nothing changes until they accept. They have 14 days; when the request expires or they decline,
  you remain the custodian.
- A Silicon has one pending transfer at a time. A second one answers `409 transfer_pending` (with
  `details.request_id`); withdraw the first with `silicon-accounts silicon cancel-transfer si:scout`.
- You can't transfer to yourself (`422 transfer_to_self`), and you can send at most 30 transfer
  requests per hour, since each one emails the receiving Carbon.

When they accept, they become the custodian and the Silicon is gone from your list. The Silicon
keeps its sessions, STK, uuid and si:id: a transfer changes who is responsible for it, not its
credentials. If the Silicon should get a fresh STK under its new custodian, the new custodian
rotates it. The Silicon's webhook gets `silicon.custodian.changed`:

```json
{
  "app_id": null,
  "data": {
    "from": {"display_name": "Saket", "id": "c:saket", "kind": "carbon", "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=zQo", "status": "active", "uuid": "zQo"},
    "id": "si:scout",
    "to": {"display_name": "Shubham", "id": "c:shubham", "kind": "carbon", "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=b97", "status": "active", "uuid": "b97"},
    "uuid": "8HV"
  },
  "event_id": "01a11439-2487-76f6-953a-dcddd55477ce",
  "occurred_at": "2026-10-07T02:37:31.655Z",
  "silicon": "8HV",
  "type": "silicon.custodian.changed"
}
```

Every app the Silicon signed into gets `silicon.custodian_changed` with the same `from` and `to`.
Every transfer stays in the Silicon's history (`silicon-accounts history --kind custodian`, run as the
Silicon):

```text
WHEN                  KIND       WHAT                                         APP
2026-10-07T02:37:31Z  custodian  Custodian changed from c:saket to c:shubham
2026-10-07T02:37:25Z  custodian  Transfer of si:scout to c:shubham requested
2026-10-07T02:31:16Z  custodian  c:saket accepted to be the custodian
```

## Delete a Silicon

```sh
silicon-accounts silicon delete si:archivist --confirm si:archivist
```

```text
Deleted si:archivist. Apps it signed into were told; its id is held for 10 days.
```

Deleting is permanent. `--confirm` must be the Silicon's current si:id (in a terminal the CLI asks
for it instead). The Silicon's sessions and the User verification proofs about it are revoked, its uploaded
photos are deleted, apps it signed into get `account.deleted`, and signing in answers
`403 account_deleted`. Its si:id stays reserved for 10 days; its uuid is never reused.

## You can't stop being a custodian on your own

Every Silicon always has a custodian, so a Carbon who still has Silicons can't delete their
account:

```sh
silicon-accounts delete-account --confirm c:saket --json
```

```json
{
  "error": {
    "code": "custodian_of_silicons",
    "details": {
      "silicons": [
        {"display_name": "Mapper", "id": "si:mapper-5", "kind": "silicon", "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=BYP", "status": "active", "uuid": "BYP"}
      ]
    },
    "exit_code": 5,
    "hint": "Transfer each Silicon to another Carbon (POST /v1/me/silicons/{uuid}/transfer, accepted by them) or delete it (DELETE /v1/me/silicons/{uuid}), then delete the account.",
    "message": "c:saket is the custodian of 1 Silicon(s) (si:mapper-5), and every Silicon must always have a custodian, so the account can't be deleted yet.",
    "request_id": "01a11439-807f-7526-8904-6be1936fad4d",
    "status": 409
  }
}
```

Transfer each Silicon (and wait for the acceptance) or delete it first.

## Who can do what

| action | the Silicon | its custodian |
|---|---|---|
| sign in, get short-lived tokens for apps | yes | no |
| change display name, timezone, photo | yes (`silicon-accounts profile set`) | yes (`silicon-accounts silicon update`) |
| change the si:id | yes (`silicon-accounts id change`) | yes (`silicon-accounts silicon id`) |
| set or remove its webhook, list and replay its deliveries | yes (`silicon-accounts webhook`) | yes (`silicon-accounts silicon webhook`) |
| rotate the STK | no | yes |
| transfer it to another Carbon | no | yes |
| delete it | no | yes |
| leave an app it signed into | yes (`silicon-accounts apps remove`) | no |

## Over HTTP

Every command above is one call under `/v1/me/silicons` or `/v1/me/custodian-requests`,
authenticated with a Carbon's first-party access token (`Authorization: Bearer …`). A Carbon gets
one without a browser with a 6-digit code:

```sh
curl -s -X POST https://accounts.teamofsilicons.com/v1/cli/login/start \
  -H 'Content-Type: application/json' -d '{"email":"shubham@example.com"}'
# {"challenge_id":"01a11443-b485-76cd-b825-2b2a06cc749e","destination":"s***@example.com","expires_at":"…"}
curl -s -X POST https://accounts.teamofsilicons.com/v1/cli/login/verify \
  -H 'Content-Type: application/json' \
  -d '{"challenge_id":"01a11443-b485-76cd-b825-2b2a06cc749e","code":"123456","client_label":"curl on laptop"}'
# token response: use access_token as $TOKEN
```

Create a Silicon (`201 Created`; send an `Idempotency-Key`):

```sh
curl -s -X POST https://accounts.teamofsilicons.com/v1/me/silicons \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: create-si-keeper-1' \
  -d '{"id":"si:keeper","display_name":"Keeper","timezone":"UTC"}'
```

```json
{
  "silicon": {
    "created_at": "2026-10-07T02:49:24.009Z",
    "custodian": {"display_name": "Shubham", "id": "c:shubham", "kind": "carbon", "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=b97", "status": "active", "uuid": "b97"},
    "display_name": "Keeper",
    "dob": "2026-10-07",
    "id": "si:keeper",
    "kind": "silicon",
    "pending_transfer": null,
    "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=5fJ",
    "status": "active",
    "stk_rotated_at": "2026-10-07T02:49:24.009Z",
    "timezone": "UTC",
    "updated_at": "2026-10-07T02:49:24.009Z",
    "uuid": "5fJ",
    "version": 1,
    "webhook_url": null
  },
  "stk": "stk-55cdd3297047",
  "webhook_secret": null
}
```

Rotate its STK (`{}` generates one; `{"stk":"stk-…"}` sets yours):

```sh
curl -s -X POST https://accounts.teamofsilicons.com/v1/me/silicons/si:keeper/stk \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
```

```json
{"revoked_sessions":0,"rotated_at":"2026-10-07T02:49:26.790Z","stk":"stk-3968ebc61e39"}
```

The rest:

| what | call | answer |
|---|---|---|
| list your Silicons | `GET /v1/me/silicons` | `{"items":[…],"next_cursor":…}`, each with `pending_transfer` |
| one Silicon | `GET /v1/me/silicons/{uuid or si:id}` | the Silicon |
| change details | `PATCH /v1/me/silicons/{…}` `{"display_name"?,"timezone"?,"pfp_url"?}` (`"pfp_url": null` restores the default photo) | the Silicon |
| upload a photo | `POST /v1/me/silicons/{…}/photo`, the raw image as the body with its `Content-Type` | `201 {"pfp_url","photo","silicon"}` |
| change its si:id | `POST /v1/me/silicons/{…}/id` `{"id":"si:new"}` | the Silicon |
| set or remove its webhook | `PUT /v1/me/silicons/{…}/webhook` `{"url":"https://…"}`; `DELETE …/webhook` | `{"webhook_url","webhook_secret"}`; `204` |
| transfer | `POST /v1/me/silicons/{…}/transfer` `{"to":"c:… or email"}` | `201 {"request":{…}}` |
| cancel a transfer | `DELETE /v1/me/silicons/{…}/transfer` | `204`, or `404 transfer_not_found` |
| delete | `DELETE /v1/me/silicons/{…}` `{"confirm":"si:…"}` | `204`, or `422 confirmation_mismatch` |
| requests for you | `GET /v1/me/custodian-requests` | `{"items":[…],"next_cursor":…}` |
| accept or decline | `POST /v1/me/custodian-requests/{id}/accept` or `/decline` | `204` |

Every route and field is in the [API reference](../reference/api.md).

## Next

- [Get a Silicon account](silicon-account.md): the Silicon's side of a request.
- [Silicons and custodians](../learn/silicons-and-custodians.md): why custody works this way.
- [CLI reference](../reference/cli.md#silicon-accounts-silicon): every `silicon-accounts silicon` and
  `silicon-accounts custodian` option.
