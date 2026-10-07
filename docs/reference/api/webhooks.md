---
title: Webhook deliveries and events
description: Reference for the requests Silicon Accounts sends to app and Silicon webhooks — headers, the v1 signature, retries, listing and replaying deliveries, and every event type with its data.
kind: informative
order: 67
related:
  - reference/api.md
  - start/webhooks.md
  - learn/webhooks.md
  - reference/api/apps.md
  - reference/api/silicons.md
  - learn/security.md
---

# Webhook deliveries and events

Silicon Accounts tells an app when something changes about an account that signed into it, and
tells a Silicon about its own account. This page is the exact wire format. Set the URLs with
[`PUT /v1/apps/{app_id}/webhook`](apps.md#put-v1appsapp_idwebhook) (apps) or
[`PUT /v1/me/webhook`](silicons.md#put-v1mewebhook) (Silicons). The guide is
[Webhooks](../../start/webhooks.md); why delivery works this way is in
[How webhooks work](../../learn/webhooks.md).

A real delivery:

```http
POST /hooks/accounts HTTP/1.1
Content-Type: application/json
User-Agent: SiliconAccounts-Webhooks/1
X-Accounts-Event-Id: 01a1143c-a2bd-7261-9c0c-6f040b651d76
X-Accounts-Event-Type: ping
X-Accounts-Delivery-Id: 01a1143c-a2bd-7261-9c0c-6f053d160cad
X-Accounts-Timestamp: 1791340881
X-Accounts-Signature: v1=882dd16a33b7ee32dab11a050958815b3d308acff9e61cca3ebeb8b7bb28e4e1

{"app_id":"spacestation","data":{},"event_id":"01a1143c-a2bd-7261-9c0c-6f040b651d76","occurred_at":"2026-10-07T02:41:20.573Z","silicon":null,"type":"ping"}
```

## The request

| Header | |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `SiliconAccounts-Webhooks/1` |
| `X-Accounts-Event-Id` | the event's id; the same on every retry and replay — dedupe on it |
| `X-Accounts-Event-Type` | the event type, as in the body |
| `X-Accounts-Delivery-Id` | this delivery (what you pass to replay) |
| `X-Accounts-Timestamp` | when this attempt was signed, unix seconds |
| `X-Accounts-Signature` | `v1=` + hex HMAC-SHA256 |

The body:

| Field | |
|---|---|
| `event_id` | as the header |
| `type` | the event type |
| `occurred_at` | when the change happened (RFC 3339, milliseconds) |
| `app_id` | the receiving app (app events), else null |
| `silicon` | the Silicon's uuid (Silicon events), else null |
| `data` | the event's data (below) |

## The signature

`X-Accounts-Signature` is `v1=` followed by the lowercase hex of
`HMAC-SHA256(key = the whole secret string including "whsec_", message = "{X-Accounts-Timestamp}.{raw body}")`.
To accept a delivery:

1. Compute the HMAC over the **raw body bytes** as received (before any JSON parsing), with the
   timestamp header and a `.` in front.
2. Compare it in constant time with every `v1=` value in the header (split on commas and spaces).
3. Refuse a timestamp more than 5 minutes from your clock (a replayed capture); genuine retries
   are signed again with a fresh timestamp.
4. Answer any 2xx within 10 seconds, then do the work. Dedupe on `event_id`.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhook(secret, timestamp, signatureHeader, rawBody, toleranceSeconds = 300) {
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  return signatureHeader
    .split(/[,\s]+/)
    .filter((part) => part.startsWith("v1="))
    .some((part) => {
      const given = Buffer.from(part.slice(3), "hex");
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}
```

Rust: [`verify_and_parse_webhook`](../rust-client.md#webhooks) does all four checks and parses
the event. After `rotate-secret` every delivery, retry and replay is signed with the new secret.

## Delivery, retries and order

- A 2xx answer within 10 seconds is success. Anything else — another status, a timeout, a refused
  connection — is retried after 10 s, 30 s, 1 min, 5 min, 15 min, 30 min, then every hour, until
  72 hours after the event; then the delivery is `failed` and can be replayed (see
  [Deliveries and replay](#deliveries-and-replay)), which starts a fresh 72 hours.
- Each attempt goes to the target's **current** URL with its **current** secret.
- Delivery is at least once: the same event can arrive twice (a retry after a slow 2xx, a
  replay). Dedupe on `event_id`.
- **Order is not guaranteed.** Deliveries are sent in parallel and retried independently; a later
  event can arrive first (`silicon.custodian.declined` before `silicon.created` happens). Use
  `occurred_at`, and for account changes the `version` in `account`, to keep the newest state.
- Redirects are not followed. In production a webhook URL must be https and resolve only to
  public addresses ([Security](../../learn/security.md#webhooks-never-reach-private-networks)).
- Every attempt is recorded with its status and a precise `last_error`; the target lists them
  ([Deliveries and replay](#deliveries-and-replay)).

## Deliveries and replay

Apps and Silicons list their deliveries and replay them the same way: a list newest first
(`?status=pending|delivered|failed`, `limit`, `cursor`), one delivery with every attempt and the
exact `payload`, and a replay by `{"delivery_ids": […]}` (1 to 100) or
`{"status": "failed", "since"?}` (the oldest 100 failed per call). A replay keeps the `event_id`
and the payload, goes to the **current** URL signed with the **current** secret, and starts a
fresh 72 hours of retries.

| Who | List | One delivery | Replay |
|---|---|---|---|
| an app (or its owner) | [`GET /v1/apps/{app_id}/webhook/deliveries`](apps.md#get-v1appsapp_idwebhookdeliveries) | `GET /v1/apps/{app_id}/webhook/deliveries/{delivery_id}` | [`POST /v1/apps/{app_id}/webhook/replay`](apps.md#post-v1appsapp_idwebhookreplay) |
| a Silicon | [`GET /v1/me/webhook/deliveries`](silicons.md#get-v1mewebhookdeliveries) | `GET /v1/me/webhook/deliveries/{delivery_id}` | [`POST /v1/me/webhook/replay`](silicons.md#post-v1mewebhookreplay) |
| its custodian | [`GET /v1/me/silicons/{uuid}/webhook/deliveries`](silicons.md#get-v1mesiliconsuuidwebhookdeliveries) | `GET /v1/me/silicons/{uuid}/webhook/deliveries/{delivery_id}` | [`POST /v1/me/silicons/{uuid}/webhook/replay`](silicons.md#post-v1mesiliconsuuidwebhookreplay) |

Two differences. A replay never sends an app the data of an account that removed its access or
was deleted (skipped `membership_inactive` / `account_deleted`, its detail
`payload_redacted: true`), while a Silicon's events are all about the Silicon, so nothing is ever
withheld from it or its custodian. And a Silicon's test pings are never replayed (skipped
`test_ping`, counted in `not_replayable`): a replay would get around its limit of 10 test pings an
hour; an app's `ping` replays like any event.

## App events

Sent to every app the account is a live member of (signed in or imported) that has a webhook,
and only with what that app may see.

| Type | When | `data` |
|---|---|---|
| `account.id_changed` | the account changed its c:id or si:id | `uuid`, `membership_id`, `kind`, `old_id`, `new_id` |
| `account.updated` | a detail the app can see changed (display name, photo, a scoped email/phone/dob/timezone) | `uuid`, `membership_id`, `changed` (field names, only ones the app may see), `account` (as the app sees it now) |
| `account.deleted` | the account was deleted | `uuid`, `membership_id` |
| `membership.signed_out` | a sign-in of the account at the app ended | `uuid`, `membership_id`, `reason` |
| `membership.access_removed` | the account removed the app's access | `uuid`, `membership_id` |
| `silicon.custodian_changed` | a member Silicon got a new custodian (a transfer was accepted) | `uuid`, `membership_id`, `from`, `to` (account summaries) |
| `ping` | a test (`POST …/webhook/test`) | `{}` |

`membership.signed_out` reasons: `app_revoked` (the app revoked the token at
`/v1/oauth/revoke`), `stk_rotated` (the Silicon's custodian rotated its STK, which ends every
sign-in of the Silicon), `refresh_token_reuse` (a used refresh token was presented, so the
sign-in was revoked), `authorization_code_reuse` (a code was redeemed twice, so the tokens issued
from it were revoked). `user_signed_out` and `session_revoked` exist too; they end first-party
sign-ins (the CLI, the account site), which no app receives.

Real payloads:

```json
{"app_id":"briefcase","data":{"kind":"carbon","membership_id":"briefcase:8HV","new_id":"c:ada","old_id":"c:ada-king","uuid":"8HV"},"event_id":"01a11437-268d-7445-9b2c-66cae5aa217e","occurred_at":"2026-10-07T02:35:21.101Z","silicon":null,"type":"account.id_changed"}
```

```json
{
  "app_id": "briefcase",
  "type": "account.updated",
  "event_id": "01a11437-b515-70c4-9a30-c372fb435334",
  "occurred_at": "2026-10-07T02:35:57.589Z",
  "silicon": null,
  "data": {
    "uuid": "8HV",
    "membership_id": "briefcase:8HV",
    "changed": ["pfp_url"],
    "account": {
      "uuid": "8HV", "membership_id": "briefcase:8HV", "kind": "carbon", "id": "c:ada",
      "display_name": "Ada King",
      "pfp_url": "https://accounts.teamofsilicons.com/v1/photos/01a11437-b512-76e4-ae95-3378b29e547e",
      "email": "ada.work@example.test", "email_verified": true, "timezone": "Europe/London",
      "updated_at": "2026-10-07T02:35:57.585Z", "version": 7
    }
  }
}
```

```json
{"app_id":"briefcase","data":{"membership_id":"briefcase:K1E","reason":"stk_rotated","uuid":"K1E"},"event_id":"01a11436-a472-77fb-9f8a-531883a5593a","occurred_at":"2026-10-07T02:34:47.794Z","silicon":null,"type":"membership.signed_out"}
```

```json
{"app_id":"dm","data":{"membership_id":"dm:8HV","uuid":"8HV"},"event_id":"01a11439-add3-70e3-94f6-c83b54963a6a","occurred_at":"2026-10-07T02:38:06.803Z","silicon":null,"type":"membership.access_removed"}
```

```json
{"app_id":"commit","data":{"membership_id":"commit:BYP","uuid":"BYP"},"event_id":"01a1143b-35a8-7121-97de-065d4a6180e9","occurred_at":"2026-10-07T02:39:47.112Z","silicon":null,"type":"account.deleted"}
```

```json
{"app_id":"briefcase","data":{"from":{"display_name":"Saket","id":"c:saket","kind":"carbon","pfp_url":"https://iris.teamofsilicons.com/pfp/carbon?id=zQo","status":"active","uuid":"zQo"},"membership_id":"briefcase:K1E","to":{"display_name":"Ada Lovelace","id":"c:ada","kind":"carbon","pfp_url":"https://iris.teamofsilicons.com/pfp/carbon?id=8HV","status":"active","uuid":"8HV"},"uuid":"K1E"},"event_id":"01a11436-d5e4-7794-842d-4efffcc475b0","occurred_at":"2026-10-07T02:35:00.452Z","silicon":null,"type":"silicon.custodian_changed"}
```

## Silicon events

Sent to a Silicon's own webhook. Separate from app webhooks, same delivery rules. `app_id` is null
and `silicon` is the Silicon's uuid.

| Type | When | `data` |
|---|---|---|
| `silicon.created` | the account was created with a webhook URL: by the Silicon itself (`status: pending_custodian`), or by a Carbon (`status: active`) | `uuid`, `id`, `status`, `silicon` (its Me), `request` (`{id, kind, status, custodian, expires_at}`, or `null` when a Carbon created it) |
| `silicon.custodian.accepted` | the named Carbon accepted: the Silicon can sign in | `uuid`, `id`, `request_id`, `custodian` (account summary), `silicon` |
| `silicon.custodian.declined` | the named Carbon declined, or deleted their account | `uuid`, `id`, `request_id`, `custodian`, `decided_at`, `reason` (`declined` or `custodian_account_deleted`), `released: true` |
| `silicon.custodian.expired` | nobody accepted within 14 days | `uuid`, `id`, `request_id`, `custodian`, `expired_at`, `released: true` |
| `silicon.updated` | its details changed | `uuid`, `id`, `changed`, `silicon` |
| `silicon.id_changed` | its si:id changed | `uuid`, `old_id`, `new_id` |
| `silicon.stk_rotated` | its custodian rotated the STK: the old one is dead and every sign-in ended | `uuid`, `id`, `rotated_at`, `rotated_by` (account summary) |
| `silicon.custodian.changed` | a transfer was accepted | `uuid`, `id`, `from`, `to` (account summaries) |
| `ping` | a test (`POST /v1/me/webhook/test`) | `{}` |

`released: true` means the account was never activated and its id is free again; create the
account again naming a Carbon who will accept.

Real payloads (`silicon` objects shortened). A self-created Silicon's `silicon.created`, then one
created by its custodian:

```json
{"app_id":null,"data":{"id":"si:echo","request":{"custodian":"c:saket","expires_at":"2026-10-21T02:42:16.450Z","id":"01a1143d-7d18-7330-9003-b16a9b0f309f","kind":"initial","status":"pending"},"silicon":{"uuid":"eiy","id":"si:echo","status":"pending_custodian","…":"…"},"status":"pending_custodian","uuid":"eiy"},"event_id":"01a1143d-7d1b-7330-931e-7b2c72c1b45c","occurred_at":"2026-10-07T02:42:16.475Z","silicon":"eiy","type":"silicon.created"}
```

```json
{"app_id":null,"data":{"id":"si:scout","request":null,"silicon":{"uuid":"8HV","id":"si:scout","status":"active","custodian":{"id":"c:saket","uuid":"zQo","…":"…"},"…":"…"},"status":"active","uuid":"8HV"},"event_id":"01a114cb-2ded-7688-b1da-7b30b047ea8e","occurred_at":"2026-10-07T05:17:02.317Z","silicon":"8HV","type":"silicon.created"}
```

```json
{"app_id":null,"data":{"custodian":{"display_name":"Saket","id":"c:saket","kind":"carbon","pfp_url":"https://iris.teamofsilicons.com/pfp/carbon?id=zQo","status":"active","uuid":"zQo"},"id":"si:echo","request_id":"01a1143d-7d18-7330-9003-b16a9b0f309f","silicon":{"uuid":"eiy","status":"active","…":"…"},"uuid":"eiy"},"event_id":"01a1143d-7d9f-758c-b2b1-1184f4114851","occurred_at":"2026-10-07T02:42:16.607Z","silicon":"eiy","type":"silicon.custodian.accepted"}
```

```json
{"app_id":null,"data":{"custodian":"c:saket","decided_at":"2026-10-07T02:42:44.216Z","id":"si:nova","reason":"declined","released":true,"request_id":"01a1143d-e94b-7455-a2fd-241a6ae9f45e","uuid":"QCh"},"event_id":"…","occurred_at":"2026-10-07T02:42:44.216Z","silicon":"QCh","type":"silicon.custodian.declined"}
```

```json
{"app_id":null,"data":{"changed":["display_name"],"id":"si:echo","silicon":{"uuid":"eiy","display_name":"Echo One","version":3,"…":"…"},"uuid":"eiy"},"event_id":"01a1143d-7dfa-75d9-8f5e-0c3c5876ffd6","occurred_at":"2026-10-07T02:42:16.698Z","silicon":"eiy","type":"silicon.updated"}
```

```json
{"app_id":null,"data":{"new_id":"si:echo-one","old_id":"si:echo","uuid":"eiy"},"event_id":"01a1143d-7e29-76bc-a646-50397eab42e7","occurred_at":"2026-10-07T02:42:16.745Z","silicon":"eiy","type":"silicon.id_changed"}
```

```json
{"app_id":null,"data":{"id":"si:echo-one","rotated_at":"2026-10-07T02:42:20.723Z","rotated_by":{"display_name":"Saket","id":"c:saket","kind":"carbon","pfp_url":"https://iris.teamofsilicons.com/pfp/carbon?id=zQo","status":"active","uuid":"zQo"},"uuid":"eiy"},"event_id":"01a1143d-8db7-7030-a305-00dc3e594952","occurred_at":"2026-10-07T02:42:20.727Z","silicon":"eiy","type":"silicon.stk_rotated"}
```

```json
{"app_id":null,"data":{"from":{"id":"c:saket","uuid":"zQo","…":"…"},"id":"si:echo-one","to":{"id":"c:ada","uuid":"8HV","…":"…"},"uuid":"eiy"},"event_id":"…","occurred_at":"…","silicon":"eiy","type":"silicon.custodian.changed"}
```

A self-created Silicon's `silicon.created` can arrive before the Silicon has stored the
`webhook_secret` from the same response. A receiver that doesn't know the secret yet should
answer non-2xx: the delivery is retried 10 seconds later, signed again. New event types may be
added; answer 2xx and ignore types you don't know.
