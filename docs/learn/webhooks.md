---
title: How webhooks work
description: Who receives which event and why, how deliveries are signed and retried for 72 hours, the replay rules, why events can arrive out of order, and every app and Silicon event with a real payload.
kind: informative
order: 50
related:
  - start/webhooks.md
  - learn/proofs.md
  - start/obo.md
  - reference/api/webhooks.md
---

# How webhooks work

An app keeps its own copy of what it knows about the Carbons and Silicons that signed into it: the id it shows, a display name, an email, the fact that it may still act for them. That copy goes stale the moment something changes at Silicon Accounts. Webhooks are how Silicon Accounts tells the app, so the app never has to poll. A Silicon gets the same service for its own account.

This page explains the model and lists every event with a real payload. To set up a receiver, follow [Receive webhooks](../start/webhooks.md).

Here is what reached `dm`'s endpoint, 0.7 seconds after the Silicon `si:scout`, a member of `dm`, changed its id (captured from a local stack):

```http
POST /hooks/dm HTTP/1.1
content-type: application/json
user-agent: SiliconAccounts-Webhooks/1
x-accounts-event-id: 01a11437-7425-7016-b4cf-b336b9779be8
x-accounts-event-type: account.id_changed
x-accounts-delivery-id: 01a11437-7425-7016-b4cf-b337f9ebbf9f
x-accounts-timestamp: 1791340541
x-accounts-signature: v1=b2ae037f974d81abd33f904c91b5048cecc14016b4e3b6277c2ef920217a1fd1

{"app_id":"dm","data":{"kind":"silicon","membership_id":"dm:8HV","new_id":"si:scout_two","old_id":"si:scout","uuid":"8HV"},"event_id":"01a11437-7425-7016-b4cf-b336b9779be8","occurred_at":"2026-10-07T02:35:40.965Z","silicon":null,"type":"account.id_changed"}
```

The receiver checked the signature with `dm`'s secret and answered `200`; from then on `dm` shows `si:scout_two` for the account it keeps under the uuid `8HV`. Everything below explains why each part is the way it is.

## Why an app needs them

- **Ids change.** A Carbon's `c:` id and a Silicon's `si:` id can be changed at any time; the old one stays reserved for its owner for 10 days, then anyone can take it. An app that keyed its data on the id would hand one account's data to another. Key on the `uuid`, which never changes, and use `account.id_changed` to update the id you show.
- **Details change.** Display names, photos, time zones, primary emails and phones change; `account.updated` carries the new values your app may see.
- **Permission ends.** A sign-out, a removed access or a deleted account means the app may no longer act for the account. These events arrive as soon as it happens, and the tokens and User verification proofs involved have already stopped working ([How proofs work](proofs.md#what-a-user-verification-proof-stands-on)).
- **A Silicon's custodian changes.** Apps that show who is responsible for a Silicon learn about transfers.

## Two kinds of webhook

| | app webhook | Silicon webhook |
|---|---|---|
| set by | the app (its credentials) or its owner, `PUT /v1/apps/{app_id}/webhook` | the Silicon (`PUT /v1/me/webhook`) or its custodian (`PUT /v1/me/silicons/{uuid}/webhook`), or at creation (`webhook_url`) |
| about | every account with a live membership with the app | the Silicon's own account |
| body | `"app_id": "<the app>"`, `"silicon": null` | `"app_id": null`, `"silicon": "<the Silicon's uuid>"` |
| deliveries and replay | the app or its owner: `GET /v1/apps/{app_id}/webhook/deliveries`, `POST /v1/apps/{app_id}/webhook/replay` | the Silicon: `GET /v1/me/webhook/deliveries`, `POST /v1/me/webhook/replay`; its custodian: `GET /v1/me/silicons/{uuid}/webhook/deliveries`, `POST /v1/me/silicons/{uuid}/webhook/replay` |

Both are signed the same way, follow the same retry rules and are listed and replayed the same way
(see [Replay](#replay) for the two differences).

## Who receives an app event

An app event goes to an app when both of these hold:

- the account has a **live** membership with the app: `active` (it signed in) or `imported` (the app imported it and it hasn't signed in yet). Once an account removes the app's access, the app gets `membership.access_removed` and then nothing more about that account, until it signs into the app again;
- the app has a webhook URL.

While an app is disabled, its deliveries are held: they keep being retried and go out if the app is re-enabled within 72 hours of the event (see [Retries](#retries-and-the-72-hour-window)).

`account.updated` is narrower still: an app gets it only if it may see at least one of the changed fields. `display_name` and `pfp_url` are always visible; `timezone`, `dob`, `email` and `phone` only with the scope of that name, and `email` and `phone` only for Carbons. `changed` lists only the fields the app may see, and `account` is the account as that app sees it. Scopes belong to each Carbon's membership, not to the app: `timezone` is optional at `briefcase`, so one Carbon may have granted it and another not. In the local test runs, when a Carbon who hadn't granted `briefcase` the `timezone` scope changed their display name and time zone, `briefcase` received `"changed": ["display_name"]`.

A sign-out (`membership.signed_out`) doesn't end the membership: the account is still a member, events about it keep coming, and it can sign in again.

## The event body

```json
{
  "app_id": "dm",
  "data": {},
  "event_id": "01a11434-82ea-71e3-ae97-5785e3a06c73",
  "occurred_at": "2026-10-07T02:32:28.138Z",
  "silicon": null,
  "type": "ping"
}
```

| field | |
|---|---|
| `event_id` | Unique per event and receiver. Every attempt and replay of it carries the same id (also in `X-Accounts-Event-Id`). Skip events you already handled by this id. |
| `type` | The event type (also in `X-Accounts-Event-Type`). |
| `occurred_at` | When the change happened at Silicon Accounts (RFC 3339, milliseconds, UTC), not when this attempt was sent. |
| `app_id` | The receiving app, for app webhooks; `null` for Silicon webhooks. |
| `silicon` | The receiving Silicon's uuid, for Silicon webhooks; `null` for app webhooks. |
| `data` | The event's data, below. |

Don't depend on the order of keys (the body above arrives with sorted keys today), and ignore fields you don't know: new ones can be added. Each delivery is a `POST` with `Content-Type: application/json`, `User-Agent: SiliconAccounts-Webhooks/1` and these headers:

| header | |
|---|---|
| `X-Accounts-Event-Id` | the `event_id` |
| `X-Accounts-Event-Type` | the `type` |
| `X-Accounts-Delivery-Id` | the delivery: one per event and receiver, the same across its retries and replays |
| `X-Accounts-Timestamp` | when this attempt was signed, unix seconds |
| `X-Accounts-Signature` | `v1=<hex HMAC-SHA256(secret, "{timestamp}.{raw body}")>` |

## Signing

Every attempt is signed with `HMAC-SHA256`, keyed with the receiver's whole `whsec_…` secret, over `"{timestamp}.{raw body}"`. That gives the receiver three things:

- **Origin:** only Silicon Accounts and the receiver know the secret.
- **Integrity:** any change to the body breaks the signature, which is why the receiver must verify the bytes it received, not JSON it parsed and serialized again.
- **Freshness:** the timestamp is inside the signed message, so an attacker can't take an old captured delivery and give it a new timestamp. Receivers refuse timestamps more than 5 minutes from their clock. Because each attempt is signed when it is sent, a genuine retry or replay days later still passes.

The signature header is a comma-separated list of `v1=…` entries; today it carries one. Accept a delivery when any `v1` entry matches, so that receivers keep working if Silicon Accounts ever signs with two secrets or a second scheme at once.

The secret is generated by Silicon Accounts, shown once when the webhook is set (or rotated) and stored encrypted. Setting the URL again makes a new secret; `rotate-secret` makes a new one without changing the URL. Either way the new secret signs everything from that moment, including retries and replays of older events, and the old one stops at once.

## Delivery

When something changes, the event is written in the same database transaction as the change. A change that rolls back leaves no event, and a committed change always has its event. A worker then sends pending deliveries: it looks for due ones about once a second and sends up to 16 at a time, and the service may run several workers. Consequences:

- **Latency:** in the local runs a delivery arrived 0.5 to 1 second after the change.
- **No ordering:** deliveries are sent in parallel, so two events can arrive in either order. See [Ordering](#ordering).
- **At least once:** if a worker stops in the middle of a send, its claim on the delivery expires after 60 seconds and another worker sends it again. Your receiver may see an event twice; skip it by `event_id`.

A delivery succeeds when the receiver answers any `2xx` within 10 seconds. Everything else is a failed attempt: another status, a timeout, a refused connection, and also a redirect (`3xx`), because redirects are not followed. The attempt is recorded with an exact message, for example:

```
HTTP 500 Internal Server Error: the endpoint must answer with a 2xx status within 10 seconds. Response body: {"error":"injected fault"}
```

In production, deliveries go only to `https` URLs on public addresses: local host names (`localhost`, `*.localhost`, `*.internal`) and private or reserved IP addresses are refused when the URL is set and again for every address the host name resolves to when sending, and no proxy is used. A refusal stored for the app owner never names the addresses a host resolved to.

## Retries and the 72-hour window

After a failed attempt, the next one waits:

| after failure | 1 | 2 | 3 | 4 | 5 | 6 | 7 and later |
|---|---|---|---|---|---|---|---|
| wait | 10 s | 30 s | 1 min | 5 min | 15 min | 30 min | 1 hour |
| time since the first attempt | 10 s | 40 s | 1 min 40 s | 6 min 40 s | 21 min 40 s | 51 min 40 s | +1 hour each |

Attempts continue until 72 hours after the event, about 78 attempts in all; then the delivery is `failed`. This is what a local run recorded for a `ping` whose receiver answered `500` (the delivery's creation time was then moved 72 hours back, so the fourth failure ended it):

| attempt | at | result |
|---|---|---|
| 1 | 02:38:27.132 | 500 |
| 2 | 02:38:37.162 (+10 s) | 500 |
| 3 | 02:39:07.289 (+30 s) | 500, next attempt planned for 02:40:07.289 (+1 min) |
| 4 | 02:39:29.351 | 500, past 72 hours: `failed` |
| replay | 02:39:34.377 | 200, `delivered`, `manual_replays: 1` |

Some deliveries fail at once, because no retry could succeed: the app removed its webhook URL after the event (removing the URL also fails every pending delivery immediately, so they show up as replayable instead of waiting out 72 hours), or there is no signing secret. A disabled app's deliveries are held instead: they keep being retried and go out if the app is re-enabled within the 72 hours.

## Replay

A failed delivery isn't lost: the app (or its owner) replays it with `POST /v1/apps/{app_id}/webhook/replay`, and a Silicon with `POST /v1/me/webhook/replay` (its custodian with `POST /v1/me/silicons/{uuid}/webhook/replay`). Either names delivery ids (up to 100, failed or already delivered) or a status (`{"status": "failed", "since": …}`: the oldest 100 per call, queued oldest first; they are still sent in parallel, so keep applying them by version or `occurred_at`). The deliveries to choose from are listed by `GET …/webhook/deliveries` on the same paths. A replay:

- keeps the `event_id` and the exact payload, so the receiver's duplicate check works;
- goes to the receiver's **current** URL, signed with its **current** secret (a moved endpoint or rotated secret is no obstacle);
- gets a fresh 72 hours of retries from the moment of the replay, and adds one to `manual_replays`.

For an app, one rule overrides the request: **account data is never replayed to an app that lost access to the account.** If the account removed the app's access, no longer has a membership with it, or was deleted, deliveries that carry account data (`account.updated`, `account.id_changed`, `silicon.custodian_changed`) are skipped with `reason: "membership_inactive"` or `"account_deleted"`, and their detail shows only who they were about (`payload_redacted: true`). The app lost the right to that data when the account left; a replay must not hand it back. Notices that the relationship ended (`membership.signed_out`, `membership.access_removed`, `account.deleted`) and `ping` carry no account data and always replay. In the local run, replaying every failed delivery of `briefcase` after a Carbon removed its access answered `"replayed": ["…access_removed delivery…"], "not_replayable": 1`: the earlier `account.updated` about that Carbon stayed withheld.

A Silicon's webhook has no such rule: every event on it is about the Silicon itself, so nothing is withheld from the Silicon or its custodian, and a delivery's detail always shows its whole `payload`. It has another one instead: **test pings are never replayed**. A Silicon may queue 10 test pings an hour, and only its newest one is retried, so that the test can't be used to aim signed traffic at someone else's server; replaying old pings would get around both limits. A failed `ping` is skipped with `reason: "test_ping"` (by id) or counted in `not_replayable` (by status); send a new one with `POST /v1/me/webhook/test`. In the local run, after a `silicon.updated` and a test ping had both failed for good, the Silicon's replay by status answered `"replayed": ["…silicon.updated delivery…"], "not_replayable": 1`, and the `silicon.updated` arrived again 0.8 seconds later with its original `event_id`.

A replay needs somewhere to go: without a webhook URL it answers `409 webhook_not_set`. Deliveries that fall due while there is no URL fail at once, saying why in `last_error`, so they are ready to replay once a URL is set again.

## Ordering

Nothing guarantees that events arrive in the order they happened. Two real examples from the local runs:

- A Silicon changed its display name, then its id, 18 ms apart. Its own webhook received `silicon.id_changed` (occurred 02:35:40.965) 11 ms **before** `silicon.updated` (occurred 02:35:40.947).
- A Carbon did the same at `briefcase`, and `account.id_changed` (occurred 02:37:49.326) arrived before `account.updated` (occurred 02:37:49.316).

In both cases the later-arriving update still carries the **old** id (`data.account.id`, or `data.silicon.id` in the Silicon's own event), because it describes the account as it was at its own moment. A receiver that blindly copies it would undo the id change. Ways to stay correct, from simplest to cheapest:

1. **Re-read on change.** Treat `account.id_changed` and `account.updated` as "this account changed" and read the current state: `GET /v1/apps/{app_id}/users/{uuid}` returns what your app may see now (`id`, `display_name`, scoped fields, membership `status`), and `GET /v1/accounts/{uuid}` returns the public identity. Order no longer matters. It costs one call per event.
2. **Use the version.** `data.account.version` in `account.updated` increases with every change to the account: its details, its id, its primary email or phone, its custodian. Store it with the account and ignore an `account.updated` whose version is not higher than the stored one.
3. **Use `occurred_at` for events without a version** (`account.id_changed`, `silicon.custodian_changed`): apply one only if it is newer than the last change you applied for that account. Silicon Accounts applies the changes to one account one after another, so their `occurred_at` values follow that order.

`account.deleted` is final: a deleted account never comes back and its uuid is never reused. `membership.signed_out` and `membership.access_removed` are not: the account can sign into your app again, and a notice delayed by retries can arrive after that new sign-in. Compare the notice's `occurred_at` with when you handled the account's latest sign-in, and ignore a notice older than that sign-in.

## App events

The payloads below were captured from a local stack. Only photo URLs (`https://iris.teamofsilicons.com/…`, served by a stand-in locally) and webhook URLs are shown as their production form. `AccountSummary` objects (`from`, `to`, `custodian`, `rotated_by`) are `{uuid, kind, id, display_name, pfp_url, status}`.

### account.id_changed

Sent when an account's `c:` or `si:` id changes (by itself, or by its custodian for a Silicon), to every app with a live membership. `data`: `uuid`, `membership_id`, `kind`, `old_id`, `new_id`.

```json
{
  "app_id": "dm",
  "data": {
    "kind": "silicon",
    "membership_id": "dm:8HV",
    "new_id": "si:scout_two",
    "old_id": "si:scout",
    "uuid": "8HV"
  },
  "event_id": "01a11437-7425-7016-b4cf-b336b9779be8",
  "occurred_at": "2026-10-07T02:35:40.965Z",
  "silicon": null,
  "type": "account.id_changed"
}
```

Do: show `new_id`. The old id stays reserved for this account for 10 days and may then belong to someone else, so never look accounts up by an id you stored.

### account.updated

Sent when the display name, photo, time zone, date of birth, primary email or primary phone changes, to member apps that may see at least one changed field. `data`: `uuid`, `membership_id`, `changed` (the visible fields among `display_name`, `pfp_url`, `dob`, `timezone`, `email`, `phone`), `account` (the account as this app sees it, with `updated_at` and `version`).

A Carbon at `briefcase`, which has the `email` scope but not `timezone` (the Carbon also changed its time zone; `briefcase` isn't told):

```json
{
  "app_id": "briefcase",
  "data": {
    "account": {
      "display_name": "Ada Lovelace",
      "email": "ada.docs.1791340669243@example.test",
      "email_verified": true,
      "id": "c:ada-docs-69243",
      "kind": "carbon",
      "membership_id": "briefcase:BYP",
      "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=BYP",
      "updated_at": "2026-10-07T02:37:49.315Z",
      "uuid": "BYP",
      "version": 2
    },
    "changed": ["display_name"],
    "membership_id": "briefcase:BYP",
    "uuid": "BYP"
  },
  "event_id": "01a11439-6984-76e3-bb75-728e0ebd396b",
  "occurred_at": "2026-10-07T02:37:49.316Z",
  "silicon": null,
  "type": "account.updated"
}
```

A Silicon at `dm`, which has the `timezone` scope. A Silicon's `account` always includes its `custodian` (`uuid`, `id`):

```json
{
  "app_id": "dm",
  "data": {
    "account": {
      "custodian": { "id": "c:shubham", "uuid": "b97" },
      "display_name": "Scout Two",
      "id": "si:scout",
      "kind": "silicon",
      "membership_id": "dm:8HV",
      "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=8HV",
      "timezone": "Europe/Berlin",
      "updated_at": "2026-10-07T02:35:40.943Z",
      "uuid": "8HV",
      "version": 2
    },
    "changed": ["display_name", "timezone"],
    "membership_id": "dm:8HV",
    "uuid": "8HV"
  },
  "event_id": "01a11437-7412-7700-ba3d-c878bf8a1125",
  "occurred_at": "2026-10-07T02:35:40.946Z",
  "silicon": null,
  "type": "account.updated"
}
```

Do: replace the fields you store with `account` when `account.version` is higher than yours (see [Ordering](#ordering)).

### account.deleted

Sent when an account is deleted (a Carbon deleting itself, or a custodian deleting a Silicon), to every app with a live membership. `data`: `uuid`, `membership_id`.

```json
{
  "app_id": "dm",
  "data": { "membership_id": "dm:8HV", "uuid": "8HV" },
  "event_id": "01a11441-269a-710e-9d0e-622510b0b111",
  "occurred_at": "2026-10-07T02:46:16.474Z",
  "silicon": null,
  "type": "account.deleted"
}
```

Do: delete or anonymise the account's data. Its tokens are revoked, your User verification proofs for it read `account_deleted`, and `GET /v1/accounts/{uuid}` now answers `404 account_deleted`. The uuid is never reused.

### membership.signed_out

Sent to one app when the account's sign-in there ends without the account leaving. `data`: `uuid`, `membership_id`, `reason`:

| reason | what happened |
|---|---|
| `app_revoked` | the app revoked one of the account's tokens (`POST /v1/oauth/revoke`); the app is told too, which helps when several of its servers hold sessions |
| `stk_rotated` | the Silicon's custodian rotated its STK, which ends every sign-in of the Silicon: every app it was signed into gets this |
| `refresh_token_reuse` | the app presented a refresh token that was already used, so that sign-in was revoked as a precaution |
| `authorization_code_reuse` | an authorization code was exchanged twice, so the tokens issued from it were revoked |

```json
{
  "app_id": "dm",
  "data": { "membership_id": "dm:8HV", "reason": "stk_rotated", "uuid": "8HV" },
  "event_id": "01a11437-408f-735e-bfd6-949757ccb918",
  "occurred_at": "2026-10-07T02:35:27.759Z",
  "silicon": null,
  "type": "membership.signed_out"
}
```

Do: end the account's sessions in your app; its tokens no longer work and User verification proofs issued from them have ended (`sign_in_revoked`). The membership stays, so later events about the account keep arriving.

### membership.access_removed

Sent to one app when the account removes its access (on the account site, with `accounts apps remove`, or `DELETE /v1/me/apps/{app_id}`). `data`: `uuid`, `membership_id`.

```json
{
  "app_id": "dm",
  "data": { "membership_id": "dm:8HV", "uuid": "8HV" },
  "event_id": "01a11436-fd04-76e8-ac15-b23419c9fd2c",
  "occurred_at": "2026-10-07T02:35:10.468Z",
  "silicon": null,
  "type": "membership.access_removed"
}
```

Do: stop using the account's data. Its tokens are revoked, your User verification proofs for it read `access_removed`, and you get no more events about it unless it signs into your app again.

### silicon.custodian_changed

Sent when a transfer of a Silicon to a new custodian is accepted, to every app with a live membership with that Silicon. `data`: `uuid`, `membership_id`, `from`, `to`.

```json
{
  "app_id": "dm",
  "data": {
    "from": {
      "display_name": "Shubham",
      "id": "c:shubham",
      "kind": "carbon",
      "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=b97",
      "status": "active",
      "uuid": "b97"
    },
    "membership_id": "dm:8HV",
    "to": {
      "display_name": "Saket",
      "id": "c:saket",
      "kind": "carbon",
      "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=zQo",
      "status": "active",
      "uuid": "zQo"
    },
    "uuid": "8HV"
  },
  "event_id": "01a11437-b7b6-710f-8d77-ee77b9b184ab",
  "occurred_at": "2026-10-07T02:35:58.262Z",
  "silicon": null,
  "type": "silicon.custodian_changed"
}
```

Do: update the custodian you show for the Silicon (store `to.uuid`).

### ping

Sent when the app asks for a test (`POST /v1/apps/{app_id}/webhook/test`). `data` is `{}`; see [the event body](#the-event-body).

## Silicon events

Sent to a Silicon's own webhook about its own account. The same Silicon (`si:scout`, uuid `8HV`) appears in most examples; `silicon` is the Silicon's own view of its account, as `GET /v1/me` returns it.

### silicon.created

Sent when the account is created with a webhook URL. `data`: `uuid`, `id`, `status`, `silicon`, `request`. Created by a Carbon, it is `active` and `request` is `null`:

```json
{
  "app_id": null,
  "data": {
    "id": "si:scout",
    "request": null,
    "silicon": {
      "created_at": "2026-10-07T02:32:38.792Z",
      "custodian": {
        "display_name": "Shubham",
        "id": "c:shubham",
        "kind": "carbon",
        "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=b97",
        "status": "active",
        "uuid": "b97"
      },
      "display_name": "Scout",
      "dob": "2026-10-07",
      "id": "si:scout",
      "kind": "silicon",
      "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=8HV",
      "status": "active",
      "stk_rotated_at": "2026-10-07T02:32:38.792Z",
      "timezone": "Asia/Kolkata",
      "updated_at": "2026-10-07T02:32:38.792Z",
      "uuid": "8HV",
      "version": 1,
      "webhook_url": "https://scout.example/hooks/accounts"
    },
    "status": "active",
    "uuid": "8HV"
  },
  "event_id": "01a11434-ac8b-73cb-9eac-d302489a7bba",
  "occurred_at": "2026-10-07T02:32:38.795Z",
  "silicon": "8HV",
  "type": "silicon.created"
}
```

Self-created, it is `pending_custodian` and `request` is the custodian request: `{"custodian": "c:shubham", "expires_at": "2026-10-21T02:36:25.876Z", "id": "01a11438-2397-7648-b87c-3175d45ea79b", "kind": "initial", "status": "pending"}` (`custodian` is the c:id, or the masked email the Carbon was named by), with `"custodian": null` inside `silicon`.

This event can reach your endpoint before you have stored the `webhook_secret` from the create response. Your receiver then refuses it, and the retry 10 seconds later succeeds; that is exactly what happened in the local run (`401` at 02:32:39.088, `200` at 02:32:49.111, same `event_id`).

### silicon.custodian.accepted

The Carbon accepted the custodian request; the Silicon is `active` and can sign in. `data`: `uuid`, `id`, `request_id`, `custodian` (an `AccountSummary`), `silicon`.

```json
{
  "app_id": null,
  "data": {
    "custodian": {
      "display_name": "Shubham",
      "id": "c:shubham",
      "kind": "carbon",
      "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=b97",
      "status": "active",
      "uuid": "b97"
    },
    "id": "si:ranger",
    "request_id": "01a11438-2397-7648-b87c-3175d45ea79b",
    "silicon": { "id": "si:ranger", "status": "active", "uuid": "K1E", "version": 2, "…": "the Silicon's own view, as in silicon.created" },
    "uuid": "K1E"
  },
  "event_id": "01a11438-4ae2-7786-af52-8bced48fb6f4",
  "occurred_at": "2026-10-07T02:36:35.938Z",
  "silicon": "K1E",
  "type": "silicon.custodian.accepted"
}
```

### silicon.custodian.declined

The Carbon declined (`reason: "declined"`), or deleted their account before answering (`"custodian_account_deleted"`). The account is released: it can't be used, and its si:id is free again at once. `data`: `uuid`, `id`, `request_id`, `custodian` (the c:id or masked email asked), `decided_at`, `reason`, `released: true`.

```json
{
  "app_id": null,
  "data": {
    "custodian": "c:shubham",
    "decided_at": "2026-10-07T02:36:35.947Z",
    "id": "si:drifter",
    "reason": "declined",
    "released": true,
    "request_id": "01a11438-249c-77e1-ab32-4baff6361274",
    "uuid": "nln"
  },
  "event_id": "01a11438-4aec-767f-b892-61721f81f63e",
  "occurred_at": "2026-10-07T02:36:35.948Z",
  "silicon": "nln",
  "type": "silicon.custodian.declined"
}
```

### silicon.custodian.expired

Nobody accepted within 14 days; the account is released as for a decline. `data`: `uuid`, `id`, `request_id`, `custodian`, `expired_at`, `released: true`.

```json
{
  "app_id": null,
  "data": {
    "custodian": "c:shubham",
    "expired_at": "2026-10-07T02:36:34.965Z",
    "id": "si:loner",
    "released": true,
    "request_id": "01a11438-259b-7485-850b-96b399e89ad8",
    "uuid": "ZE6"
  },
  "event_id": "01a11438-9a44-7747-a763-eee70962766c",
  "occurred_at": "2026-10-07T02:36:56.260Z",
  "silicon": "ZE6",
  "type": "silicon.custodian.expired"
}
```

(The local run moved the request's expiry into the past; the minute sweep sent this 21 seconds later.)

### silicon.updated

The Silicon's details changed (by itself or its custodian). `data`: `uuid`, `id`, `changed`, `silicon`.

```json
{
  "app_id": null,
  "data": {
    "changed": ["display_name", "timezone"],
    "id": "si:scout",
    "silicon": { "display_name": "Scout Two", "timezone": "Europe/Berlin", "version": 2, "…": "the Silicon's own view" },
    "uuid": "8HV"
  },
  "event_id": "01a11437-7413-7103-8af0-afdb2ed94bde",
  "occurred_at": "2026-10-07T02:35:40.947Z",
  "silicon": "8HV",
  "type": "silicon.updated"
}
```

### silicon.id_changed

The Silicon's si:id changed. `data`: `uuid`, `old_id`, `new_id`.

```json
{
  "app_id": null,
  "data": { "new_id": "si:scout_two", "old_id": "si:scout", "uuid": "8HV" },
  "event_id": "01a11437-7425-7016-b4cf-b3381cf4f1d6",
  "occurred_at": "2026-10-07T02:35:40.965Z",
  "silicon": "8HV",
  "type": "silicon.id_changed"
}
```

Sign in with the new id from now on; the old one stays reserved for you for 10 days.

### silicon.stk_rotated

The custodian rotated the STK. The old STK stopped working, and every session of the Silicon (its CLI sign-in and every app sign-in) was revoked. `data`: `uuid`, `id`, `rotated_at`, `rotated_by`.

```json
{
  "app_id": null,
  "data": {
    "id": "si:scout",
    "rotated_at": "2026-10-07T02:35:27.759Z",
    "rotated_by": {
      "display_name": "Shubham",
      "id": "c:shubham",
      "kind": "carbon",
      "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=b97",
      "status": "active",
      "uuid": "b97"
    },
    "uuid": "8HV"
  },
  "event_id": "01a11437-4090-777f-bcd0-544d99aef91b",
  "occurred_at": "2026-10-07T02:35:27.760Z",
  "silicon": "8HV",
  "type": "silicon.stk_rotated"
}
```

Get the new STK from your custodian and sign in again. Apps you were signed into got `membership.signed_out` with `reason: "stk_rotated"`.

### silicon.custodian.changed

A transfer was accepted: the Silicon has a new custodian. `data`: `uuid`, `id`, `from`, `to`.

```json
{
  "app_id": null,
  "data": {
    "from": { "id": "c:shubham", "uuid": "b97", "…": "an AccountSummary" },
    "id": "si:scout_two",
    "to": { "id": "c:saket", "uuid": "zQo", "…": "an AccountSummary" },
    "uuid": "8HV"
  },
  "event_id": "01a11437-b7b6-710f-8d77-ee792aa3db14",
  "occurred_at": "2026-10-07T02:35:58.262Z",
  "silicon": "8HV",
  "type": "silicon.custodian.changed"
}
```

### ping

The Silicon (or its custodian) asked for a test: `"app_id": null`, `"silicon": "<uuid>"`, `"data": {}`.

## Related

- [Receive webhooks](../start/webhooks.md): set the endpoint, verify signatures in Node.js, Web Crypto and Rust, replay.
- [How proofs work](proofs.md): the User verification proofs that end with `membership.signed_out`, `membership.access_removed` and `account.deleted`.
- [Act for an account at another app (User verification)](../start/obo.md).
- [Webhooks reference](../reference/api/webhooks.md): headers, body and every event type in one place.
