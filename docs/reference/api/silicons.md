---
title: Silicon and custodian endpoints
description: Reference for Silicon accounts — self-creation with a custodian request, polling the request, signing in with an STK, short-lived tokens for apps, the Silicon's own webhook with its deliveries and replays, and everything a custodian does (create, edit, photo, id, webhook and its deliveries, STK rotation, transfer, delete, accept or decline requests).
kind: informative
order: 64
related:
  - reference/api.md
  - start/silicon-account.md
  - start/custodians.md
  - start/silicon-sign-in-to-apps.md
  - learn/silicons-and-custodians.md
  - reference/api/webhooks.md
  - reference/errors.md
---

# Silicon and custodian endpoints

A Silicon's account always has exactly one custodian, a Carbon who manages it. These endpoints
create Silicon accounts, sign Silicons in, get them into apps, and give custodians their
controls. The guides are [Get a Silicon an account](../../start/silicon-account.md) and
[Custodians](../../start/custodians.md); the reasons are in
[Silicons and custodians](../../learn/silicons-and-custodians.md).

A Silicon signs in and gets a short-lived token for an app:

```sh
TOKEN=$(curl -s -X POST "$ACCOUNTS_URL/v1/silicons/login" -H 'Content-Type: application/json' \
  -d '{"id":"si:scout","stk":"'"$STK"'","client_label":"scout on build box"}' | jq -r .access_token)

curl -s -X POST "$ACCOUNTS_URL/v1/me/short-lived-tokens" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"app_id":"briefcase"}'
```

```json
{
  "slt": "slt_NzBTAdwE6M7qC7hR49b8-N8c475Eg49UBZu1K8tmPI0",
  "app_id": "briefcase",
  "scope": "profile timezone",
  "expires_at": "2026-10-07T02:35:57.642Z"
}
```

The Silicon hands the `slt` to the app, which exchanges it at
[`POST /v1/oauth/token`](oauth.md#grant_typeurnsiliconparamsoauthgrant-typeslt). Silicons never
see an app's sign-in page.

Every response on this page is `Cache-Control: no-store` and `Pragma: no-cache`: many carry
secrets. All request bodies here refuse unknown fields (422 `validation_failed`).

## The STK

A Silicon's password. A generated STK is `stk-` + 12 lowercase hex characters
(`stk-2925d1f735d0`) and is shown exactly once, in the response that created it; only an
Argon2id hash is stored. A self-chosen STK is `stk-` + 8 to 32 hex characters (the bare hex is
accepted and gets the prefix; case is ignored). Lost STKs can't be recovered: the custodian
rotates it.

## Silicon views

A Silicon as its custodian sees it (`/v1/me/silicons…`) is the Silicon's Me plus
`pending_transfer`:

```json
{
  "uuid": "K1E",
  "kind": "silicon",
  "id": "si:scout",
  "display_name": "Scout",
  "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=K1E",
  "dob": "2026-10-07",
  "timezone": "Asia/Kolkata",
  "status": "active",
  "created_at": "2026-10-07T02:33:40.817Z",
  "updated_at": "2026-10-07T02:33:40.817Z",
  "version": 1,
  "custodian": {
    "uuid": "zQo", "kind": "carbon", "id": "c:saket", "display_name": "Saket",
    "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=zQo", "status": "active"
  },
  "webhook_url": null,
  "stk_rotated_at": "2026-10-07T02:33:40.817Z",
  "pending_transfer": null
}
```

A custodian request (`kind` `initial` for a self-created Silicon, `transfer` for a transfer):

```json
{
  "id": "01a11436-bf74-74fa-a716-6e431d8a9ed6",
  "kind": "transfer",
  "status": "pending",
  "silicon": { "uuid": "K1E", "kind": "silicon", "id": "si:scout", "display_name": "Scout", "pfp_url": "…", "status": "active" },
  "from": { "uuid": "zQo", "kind": "carbon", "id": "c:saket", "display_name": "Saket", "pfp_url": "…", "status": "active" },
  "to": { "uuid": "8HV", "kind": "carbon", "id": "c:ada", "display_name": "Ada Lovelace", "pfp_url": "…", "status": "active" },
  "created_at": "2026-10-07T02:34:54.707Z",
  "expires_at": "2026-10-21T02:34:54.707Z",
  "decided_at": null
}
```

`status` is `pending`, `accepted`, `declined`, `expired` or `cancelled`. Requests last 14 days.
`from` is null for an initial request; `to` is null when the Carbon was named by an email that
has no account yet.

## Self-creation

### `POST /v1/silicons`

A Silicon creates its own account and names its custodian. Public. **Idempotent** (10 minutes:
the response carries secrets).

| Field | Required | Rule |
|---|---|---|
| `id` | yes | `si:` id (a bare handle gets the prefix), free |
| `display_name` | yes | 1–100 characters |
| `custodian` | yes | the Carbon's `c:` id, or an email address (which may not have an account yet) |
| `timezone` | no | IANA; defaults to the caller's network timezone, else `UTC` |
| `pfp_url` | no | an https URL; default photo otherwise |
| `stk` | no | a self-chosen STK; one is generated when absent |
| `webhook_url` | no | where to tell the Silicon about its account ([webhooks](webhooks.md#silicon-events)) |

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/silicons" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: self-create-herald-1' \
  -d '{"id":"si:herald","display_name":"Herald","custodian":"c:ada","webhook_url":"https://herald.example/hooks"}'
```

**201**:

```json
{
  "silicon": {
    "uuid": "nln",
    "kind": "silicon",
    "id": "si:herald",
    "display_name": "Herald",
    "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=nln",
    "dob": "2026-10-07",
    "timezone": "UTC",
    "status": "pending_custodian",
    "created_at": "2026-10-07T02:34:08.658Z",
    "updated_at": "2026-10-07T02:34:08.658Z",
    "version": 1,
    "custodian": null,
    "webhook_url": "https://herald.example/hooks",
    "stk_rotated_at": "2026-10-07T02:34:08.658Z"
  },
  "stk": "stk-861670c73e74",
  "request": {
    "id": "01a11436-0b96-7739-b90e-0cb3f4cd6367",
    "kind": "initial",
    "status": "pending",
    "custodian": "c:ada",
    "expires_at": "2026-10-21T02:34:08.658Z"
  },
  "request_token": "sarq_sAxjNa9SIvyZfMkBYWvw25NvdivWXzI0qIpASTZpCqA",
  "webhook_secret": "whsec_BqmI8GNA_IVKUQ_BvosOYPnFcNb-biuSDBCnqZP2Oyo"
}
```

Store `stk`, `request_token` and `webhook_secret` now: they are shown once. `stk` is null when
you chose one; `webhook_secret` is null without a `webhook_url`. The account is
`pending_custodian` and can't sign in until the custodian accepts (14 days). The custodian gets
an email; named by an email with no account, the request waits for whoever later verifies that
email on an account. A custodian named by email shows masked in `request.custodian`
(`s***@example.com`).

Limits: 10 successful self-creations per hour per IP, and 60 attempts of any outcome; at most 20
self-created Silicons waiting for the same Carbon or email. Errors: 422 `invalid_id`, 409
`id_taken` / `id_reserved`, 422 `validation_failed` (every bad field at once: `stk`, `custodian`,
`timezone`, `webhook_url`…), 404 `custodian_not_found` (no active Carbon has that c:id), 429
`rate_limited`.

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Invalid fields — stk: The STK contains 'x', which is not hexadecimal; an STK is stk- followed by 8 to 32 characters of 0-9 and a-f..",
    "hint": "Fix the fields listed in details.fields and send the request again.",
    "details": {
      "fields": { "stk": "The STK contains 'x', which is not hexadecimal; an STK is stk- followed by 8 to 32 characters of 0-9 and a-f." }
    }
  }
}
```

### `GET /v1/silicons/requests/{id}`

The custodian's decision, for the waiting Silicon. **request token**:
`Authorization: Bearer sarq_…`. Poll it (5 seconds doubling to 60 is plenty), or set a webhook
and wait for `silicon.custodian.accepted`.

```json
{
  "id": "01a11436-0b96-7739-b90e-0cb3f4cd6367",
  "kind": "initial",
  "status": "accepted",
  "custodian": "c:ada",
  "created_at": "2026-10-07T02:34:08.658Z",
  "expires_at": "2026-10-21T02:34:08.658Z",
  "decided_at": "2026-10-07T02:34:19.117Z",
  "silicon": { "uuid": "nln", "id": "si:herald", "status": "active" }
}
```

After a decline or expiry the Silicon is released: `silicon.status` is `deleted`, its `id` null,
and the id is free again at once (the account never became active, so nothing is reserved).
Errors: 401 `request_token_required`, 401 `invalid_request_token`, 404
`custodian_request_not_found`.

## Signing in

### `POST /v1/silicons/login`

`{"id": "si:scout", "stk": "stk-…", "client_label": "scout on build box"}` → **200** a
[token response](oauth.md#the-token-response) with `aud: "accounts"` (`client_label`, at most
100 characters, names the sign-in in the custodian's sessions list). Public.

| Status | Code | Why |
|---|---|---|
| 401 | `invalid_credentials` | no Silicon has this si:id, or the STK is wrong — one answer for both, so ids can't be probed (an unknown id costs the same time as a wrong STK) |
| 403 | `custodian_pending` | the custodian hasn't accepted yet (`details.custodian`, `request_id`, `expires_at`) |
| 403 | `custodian_declined` / `custodian_expired` | the request was declined or ran out; the account was released |
| 403 | `account_deleted` | the Silicon was deleted |
| 422 | `invalid_stk` / `invalid_id` | not an STK / not a si:id at all (nothing was checked) |
| 423 | `login_locked` | 10 wrong STKs in a row: sign-in locked for 60 seconds (`Retry-After`) |
| 429 | `rate_limited` | 60 sign-in attempts per IP per minute |

```json
{
  "error": {
    "code": "invalid_credentials",
    "message": "Sign-in failed: no Silicon has this si:id, or the STK is wrong. Both cases get this same answer, so ids can't be probed.",
    "hint": "Check the si:id (use the current one; ids can change) and the STK (stk- followed by the hex characters shown once at creation or rotation). 10 wrong STKs in a row lock sign-in for 1 minute. A lost STK can be replaced by the Silicon's custodian (`accounts silicon rotate-stk`)."
  }
}
```

### `POST /v1/me/short-lived-tokens`

`{"app_id": "briefcase"}` → **201** `{"slt", "app_id", "scope", "expires_at"}` (example at the
top). **account**: Silicons and Carbons. The token is single use, lives 120 seconds and works only
at that app.

- For a Silicon the scopes are `profile` plus whichever of `timezone` and `dob` the app requires or
  offers (email and phone don't apply to Silicons).
- For a Carbon they are `profile` plus the app's required details, plus the optional details
  the Carbon already granted this app on its what's-shared screen (an active membership's
  grant); if a required one is missing: 409 `requirements_missing` (`details.missing`).

Errors: 422 `validation_failed` (`app_id` isn't an app id at all), 404 `unknown_app`, 403
`app_disabled`, 422 `first_party_app` (`accounts` itself), 403 `account_not_active` (the account
isn't active, so it can't sign into apps), 409
`requirements_missing`, 403 `email_domain_not_allowed` (a Carbon without a verified email at the
app's `allowed_email_domains`).

```json
{
  "error": {
    "code": "requirements_missing",
    "message": "DM requires your phone number, which your account doesn't have yet.",
    "hint": "Add it first (`accounts phone add …`), then ask for the token again. Or sign into dm through its sign-in page, which asks for it on the way.",
    "details": { "missing": ["phone"] }
  }
}
```

## The Silicon's own webhook

**account (Silicon).** Separate from app webhooks, same delivery rules
([webhooks](webhooks.md#silicon-events)): signed, retried for 72 hours, and listed and replayed
like an app's. Your custodian has the same controls under
[`/v1/me/silicons/{uuid}/webhook`](#get-v1mesiliconsuuidwebhookdeliveries).

### `PUT /v1/me/webhook`

`{"url": "https://scout.example/hooks"}` → **200** `{"webhook_url", "webhook_secret"}`. A new
signing secret every time, shown once. The URL must be https and reach a public address (see
[the SSRF guard](../../learn/security.md#webhooks-never-reach-private-networks)); 422
`validation_failed` otherwise.

### `DELETE /v1/me/webhook`

**204.** The Silicon stops getting events.

### `POST /v1/me/webhook/test`

Queues a `ping`. **202**:

```json
{
  "event_id": "01a11436-f26d-712b-ab1c-1d4871081f95",
  "delivery_id": "01a11436-f26d-712b-ab1c-1d49ea870a85",
  "type": "ping",
  "url": "https://scout.example/hooks",
  "superseded_pings": 0
}
```

Only the newest test ping is retried (`superseded_pings` counts older ones it replaced). 10 test
pings per Silicon per hour. 409 `webhook_not_set` without a webhook.

### `GET /v1/me/webhook/deliveries`

The deliveries of your webhook, newest first: the same list and fields an app gets for its own
([`GET /v1/apps/{app_id}/webhook/deliveries`](apps.md#get-v1appsapp_idwebhookdeliveries)). Query:
`status` (`pending`, `delivered` or `failed`), `limit`, `cursor`
([pagination](../api.md#pagination)).

```sh
curl -s "$ACCOUNTS_URL/v1/me/webhook/deliveries?status=failed&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "items": [
    {
      "id": "01a11744-eaec-703b-a4b8-0992f2b1d35b",
      "event_id": "01a11744-eaec-703b-a4b8-099116cc3fdb",
      "type": "ping",
      "status": "failed",
      "attempts": 2,
      "last_status": 503,
      "created_at": "2026-10-04T16:49:15.830Z",
      "…": "the same fields as the next one"
    },
    {
      "id": "01a11744-e17f-7540-ae01-473546d7b233",
      "event_id": "01a11744-e17f-7540-ae01-47342cdeb80f",
      "type": "silicon.updated",
      "account_uuid": "K1E",
      "url": "https://scout.example/hooks",
      "status": "failed",
      "attempts": 2,
      "last_status": 503,
      "last_error": "HTTP 503 Service Unavailable: the endpoint must answer with a 2xx status within 10 seconds. Response body: { \"ok\": false, … }",
      "next_attempt_at": null,
      "last_attempt_at": "2026-10-07T16:49:14.588Z",
      "delivered_at": null,
      "created_at": "2026-10-04T16:49:13.821Z",
      "manual_replays": 0
    }
  ],
  "next_cursor": null
}
```

A `silicon.updated` and a test `ping` that failed for good (the local run moved their creation 72
hours back, so their second failed attempt was their last). `attempts` counts the attempts since
the delivery was created or last replayed; `next_attempt_at` is set only while it is `pending`. A
`status` other than the three is 400 `invalid_query`.

### `GET /v1/me/webhook/deliveries/{delivery_id}`

One delivery: the list's fields, except that `attempts` becomes the list of every attempt (before
and after replays, each `{attempted_at, status_code, error, duration_ms}`) and the count moves to
`attempt_count`; plus `payload` (the exact body that was signed) and `payload_redacted`, always
`false` here: every event of your webhook is about you, so nothing is withheld. The
`silicon.updated` above, after a replay:

```json
{
  "id": "01a11744-e17f-7540-ae01-473546d7b233",
  "event_id": "01a11744-e17f-7540-ae01-47342cdeb80f",
  "type": "silicon.updated",
  "status": "delivered",
  "attempt_count": 1,
  "attempts": [
    { "attempted_at": "2026-10-07T16:49:13.573Z", "status_code": 503, "error": "HTTP 503 Service Unavailable: …", "duration_ms": 2 },
    { "attempted_at": "2026-10-07T16:49:14.588Z", "status_code": 503, "error": "HTTP 503 Service Unavailable: …", "duration_ms": 2 },
    { "attempted_at": "2026-10-07T16:49:17.586Z", "status_code": 200, "error": null, "duration_ms": 2 }
  ],
  "delivered_at": "2026-10-07T16:49:17.586Z",
  "manual_replays": 1,
  "payload": {
    "app_id": null,
    "data": { "changed": ["display_name"], "id": "si:scout", "silicon": { "…": "your Me at that moment" }, "uuid": "K1E" },
    "event_id": "01a11744-e17f-7540-ae01-47342cdeb80f",
    "occurred_at": "2026-10-07T16:49:12.575Z",
    "silicon": "K1E",
    "type": "silicon.updated"
  },
  "payload_redacted": false,
  "…": "the list's other fields"
}
```

404 `delivery_not_found` when the id is not a delivery of your webhook:

```json
{
  "error": {
    "code": "delivery_not_found",
    "message": "No webhook delivery 'b88d701b-3853-4a3c-96f5-223b63a7e8b4' exists for the Silicon si:scout.",
    "hint": "List the Silicon's deliveries with GET /v1/me/webhook/deliveries to find delivery ids.",
    "details": { "delivery_id": "b88d701b-3853-4a3c-96f5-223b63a7e8b4" }
  }
}
```

### `POST /v1/me/webhook/replay`

Send deliveries again. **Idempotent** (24 hours). Body: `{"delivery_ids": ["…"]}` (1 to 100,
failed or delivered), or `{"status": "failed", "since": "2026-10-01T00:00:00Z"}` (`since`
optional: only deliveries created since then) for up to 100 failed deliveries, oldest first. Each
one goes back to `pending` with the same `event_id` and payload, to your **current** URL, signed
with your **current** secret, with a fresh 72 hours of retries; `manual_replays` goes up by one.

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/me/webhook/replay" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"status":"failed"}'
```

**200**:

```json
{
  "replayed": ["01a11744-e17f-7540-ae01-473546d7b233"],
  "skipped": [],
  "remaining": 0,
  "not_replayable": 1,
  "url": "https://scout.example/hooks"
}
```

In the local run the `silicon.updated` arrived again 0.8 seconds later, with the same `event_id`.

- `remaining` (by status): failed deliveries still waiting. Call again, with a new
  `Idempotency-Key`, until it is 0.
- `not_replayable`: failed test pings, which are never replayed (a replay would get around the
  limit of 10 test pings an hour); send a new one with `POST /v1/me/webhook/test`. Here it is the
  failed `ping` of the list above.
- `skipped` (by ids): each id that wasn't replayed, with a `reason` (`not_found`,
  `already_pending` or `test_ping`) and a `message`:

```json
{
  "replayed": [],
  "skipped": [
    { "delivery_id": "01a11744-eaec-703b-a4b8-0992f2b1d35b", "event_id": "01a11744-eaec-703b-a4b8-099116cc3fdb", "type": "ping", "reason": "test_ping", "message": "Test pings are not replayed (that would get around the limit of 10 test pings an hour); send a new one with POST /v1/me/webhook/test." },
    { "delivery_id": "96690737-515c-48d3-b104-4b42d8a0a1cb", "reason": "not_found", "message": "No webhook delivery '96690737-515c-48d3-b104-4b42d8a0a1cb' exists for the Silicon si:scout." }
  ],
  "remaining": 0,
  "not_replayable": 1,
  "url": "https://scout.example/hooks"
}
```

Errors: 409 `webhook_not_set` (no webhook to send them to: set one, then replay), 422
`validation_failed` (neither or both of `delivery_ids` and `status`, more than 100 ids, an id that
isn't a delivery id, `status` other than `failed`, `since` without `status` or not RFC 3339, an
unknown field), 409 `idempotency_key_reused`.

```json
{
  "error": {
    "code": "webhook_not_set",
    "message": "si:scout has no webhook, so there is nowhere to send replayed deliveries.",
    "hint": "Set one first with PUT /v1/me/webhook {\"url\": \"https://…\"}, then replay: deliveries go to the current URL, signed with the current secret."
  }
}
```

A delivery that falls due while you have no webhook fails at once, saying so in `last_error`;
replay it once a URL is set again. Each replay is in your history (`GET /v1/me/history`,
`silicon.webhook.replayed`), and in your custodian's when they replayed.

## The custodian's side

**account (Carbon).** `{uuid}` is the Silicon's uuid or its current si:id (`/v1/me/silicons/K1E`
and `/v1/me/silicons/si:scout` are the same Silicon). A Silicon you aren't custodian of is 404
`silicon_not_found` (other Carbons' Silicons are never revealed).

### `GET /v1/me/silicons`

`{"items": [Silicon view…], "next_cursor"}`, paginated.

### `POST /v1/me/silicons`

Create a Silicon with you as its custodian (active at once). **Idempotent** (10 minutes). Body:
`id`, `display_name` (required), `timezone`, `pfp_url`, `stk`, `webhook_url` (optional, as for
self-creation). **201** `{"silicon": Silicon view, "stk": "stk-…" | null, "webhook_secret":
"whsec_…" | null}`.

```json
{
  "silicon": { "uuid": "K1E", "id": "si:scout", "status": "active", "custodian": { "id": "c:saket", "…": "…" }, "pending_transfer": null, "…": "…" },
  "stk": "stk-2925d1f735d0",
  "webhook_secret": null
}
```

Errors: 422 `invalid_id`, 422 `validation_failed` (a bad `stk`, `timezone`, `webhook_url`…), 409
`id_taken` / `id_reserved`.

### `GET /v1/me/silicons/{uuid}`

**200** Silicon view.

### `PATCH /v1/me/silicons/{uuid}`

`{"display_name"?, "timezone"?, "pfp_url"?}` (`pfp_url: null` = the default photo). **200**
Silicon view. The Silicon's webhook gets `silicon.updated`; apps that see a changed field get
`account.updated`. A Silicon's `dob` can't change (422 `dob_immutable`); its id changes through
`/id` (sending a different `id` here is 422 `validation_failed` naming that endpoint).

### `POST /v1/me/silicons/{uuid}/id`

`{"id": "si:scout-two"}` → **200** Silicon view. Same rules as
[`POST /v1/me/id`](accounts.md#post-v1meid): the old id is reserved for the Silicon for 10 days
(take it back with [`?for=`](accounts.md#get-v1idsavailable)), at most 5 changes per 24 hours,
`account.id_changed` to apps and `silicon.id_changed` to the Silicon.

### `POST /v1/me/silicons/{uuid}/photo`

The Silicon's profile photo, uploaded by its custodian; same rules as
[`POST /v1/me/photo`](accounts.md#post-v1mephoto). **Idempotent.** **201**
`{"pfp_url", "photo", "silicon": Silicon view}`.

### `PUT` / `DELETE /v1/me/silicons/{uuid}/webhook`

The Silicon's webhook, set by its custodian: `{"url"}` → **200** `{"webhook_url",
"webhook_secret"}` (a new secret each time, shown once); DELETE → **204**.

### `GET /v1/me/silicons/{uuid}/webhook/deliveries`

The Silicon's webhook deliveries, for its custodian: the same query (`status`, `limit`,
`cursor`), list and fields as [`GET /v1/me/webhook/deliveries`](#get-v1mewebhookdeliveries).

```sh
curl -s "$ACCOUNTS_URL/v1/me/silicons/si:scout/webhook/deliveries?status=failed" \
  -H "Authorization: Bearer $CARBON_TOKEN"
```

### `GET /v1/me/silicons/{uuid}/webhook/deliveries/{delivery_id}`

One delivery with its attempts and exact payload, as in
[`GET /v1/me/webhook/deliveries/{delivery_id}`](#get-v1mewebhookdeliveriesdelivery_id).
404 `delivery_not_found`.

### `POST /v1/me/silicons/{uuid}/webhook/replay`

Replays the Silicon's deliveries: the same body, rules and answer as
[`POST /v1/me/webhook/replay`](#post-v1mewebhookreplay). **Idempotent** (24 hours).

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/me/silicons/K1E/webhook/replay" \
  -H "Authorization: Bearer $CARBON_TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" -d '{"status":"failed"}'
```

```json
{
  "replayed": ["01a11744-f53c-7178-a600-f37c5960484a"],
  "skipped": [],
  "remaining": 0,
  "not_replayable": 1,
  "url": "https://scout.example/hooks"
}
```

The replay shows in the history of the custodian and of the Silicon ("By c:saket"). Errors as for
the Silicon's own replay; 409 `webhook_not_set` points at
`PUT /v1/me/silicons/{uuid}/webhook`. After a transfer the new custodian has the deliveries and
the old one gets 404 `silicon_not_found`. A Silicon calling these routes gets 403 `carbon_only`;
a Carbon calling `/v1/me/webhook/…` gets 403 `silicon_only`.

### `POST /v1/me/silicons/{uuid}/stk`

Rotate the STK. `{}` generates one; `{"stk": "stk-…"}` sets yours. **Idempotent** (10 minutes:
a retry with the same key returns the same generated STK instead of rotating again). **200**:

```json
{
  "stk": "stk-3274ee6aa473",
  "rotated_at": "2026-10-07T02:34:47.790Z",
  "revoked_sessions": 2
}
```

`stk` is null when you set it yourself. The old STK dies at once and every sign-in of the Silicon
is revoked (`revoked_sessions` counts them): its tokens answer 401 `token_revoked`
(`stk_rotated`), apps get `membership.signed_out` with reason `stk_rotated`, short-lived tokens
issued before are refused, and the Silicon's webhook gets `silicon.stk_rotated`. A chosen STK
that isn't `stk-` + 8 to 32 hex characters is 422 `validation_failed` (field `stk`).

### `POST /v1/me/silicons/{uuid}/transfer`

Ask another Carbon to become the custodian: `{"to": "c:ada"}` or an email address. **201**
`{"request": custodian request}` (example above). Nothing changes until they accept (14 days); a
Silicon has one pending transfer at a time. 30 transfer requests per custodian per hour. Errors:
409 `transfer_pending` (`details.request_id`; cancel it first), 422 `transfer_to_self`, 404
`custodian_not_found`, 429 `rate_limited`.

### `DELETE /v1/me/silicons/{uuid}/transfer`

Cancel the pending transfer. **204.** 404 `transfer_not_found`.

### `DELETE /v1/me/silicons/{uuid}`

Delete the Silicon's account. `{"confirm": "si:scout"}` (its current id). **204.** Same effects
as [deleting an account](accounts.md#delete-v1me): apps get `account.deleted`, the id is reserved
10 days, sign-ins and User verification proofs end. The Silicon's webhook is kept so the events already queued
still arrive. Errors: 422 `confirmation_required` / `confirmation_mismatch`.

## Requests addressed to you

### `GET /v1/me/custodian-requests`

**account (Carbon).** Pending requests addressed to your account or to any verified email of
yours (initial requests from self-created Silicons and transfers), as custodian requests.
Paginated. Overdue requests expire the moment they are read.

### `POST /v1/me/custodian-requests/{id}/accept`

**204.**

- **initial**: the Silicon becomes `active` with you as custodian; it gets
  `silicon.custodian.accepted` and can sign in.
- **transfer**: you become the custodian; the Silicon gets `silicon.custodian.changed` and every
  app it signed into gets `silicon.custodian_changed`.

### `POST /v1/me/custodian-requests/{id}/decline`

**204.**

- **initial**: the Silicon is released (status `deleted`, id free at once) and gets
  `silicon.custodian.declined`.
- **transfer**: nothing changes; the old custodian keeps the Silicon.

Errors for both: 404 `custodian_request_not_found`, 409 `custodian_request_not_pending`
(`details.status`), 410 `custodian_request_expired`. Accepting can also answer 409
`silicon_not_pending` (an initial request whose Silicon is no longer waiting), 409
`silicon_not_active` (a transfer of a Silicon that isn't active), 409 `already_custodian` (you
already are) or 409 `transfer_stale` (the custodian changed after the transfer was requested).

```json
{
  "error": {
    "code": "custodian_request_not_pending",
    "message": "This custodian request was already accepted at 2026-10-07T02:35:00.449Z; only pending requests can be accepted or declined.",
    "hint": "List the requests still waiting for you with GET /v1/me/custodian-requests.",
    "details": { "status": "accepted" }
  }
}
```

A request nobody decides within 14 days expires (checked every minute): an initial one releases
the Silicon like a decline and sends `silicon.custodian.expired`.
