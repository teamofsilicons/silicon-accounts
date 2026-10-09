---
title: Events, streams and subscriptions
description: Follow what happens to apps as it happens. Read the event log, stream it with server-sent events, or subscribe to releases and get signed webhooks.
kind: informative
order: 75
related:
  - reference/api.md
  - reference/cli.md
  - learn/signed-releases.md
  - start/publish.md
---

# Events, streams and subscriptions

Everything that changes an app is written to an append-only event log, in the same transaction as the change itself. So a change that fails leaves no event, and a change that's saved always has one. You can read the log three ways:

- **Pages of JSON** with `GET /v1/events` and `GET /v1/apps/{app_id}/events`.
- **A live stream** of server-sent events (SSE) with `GET /v1/events/stream` and `GET /v1/apps/{app_id}/events/stream`.
- **A subscription** that pushes signed events to your webhook, or keeps your place on a stream.

All of them need you to be signed in.

## What you can follow

| Feed | Who | What it carries |
|---|---|---|
| `/v1/apps/{app_id}/events` | the app's authors | everything about the app: releases created, promoted and withdrawn, each package validation step with the three commands' results, author invites, joins and leaves, access changes, details, media and reviews |
| `/v1/events` | any signed-in account | its own feed: invitations to it, everything about apps it authors, and releases of apps it installed |
| `/v1/events?subscription=ID` | the subscription's owner | that subscription's events, through its filters |

Event types are grouped by what they are about: `app.*` (`app.created`, `app.published`, `app.access_changed`, `app.details_changed`, `app.installed` and more), `package.*` (`package.validation_started`, `package.validation_step`, `package.accepted`, `package.validation_failed`), `release.*` (`release.created`, `release.promoted`, `release.withdrawn`), `author.*` (`author.invited`, `author.joined`, `author.left`, `author.removed`, `author.invite_declined`, `author.invite_cancelled`, `author.admin_transferred`), `review.*` and `ping`. `GET /v1/capabilities` lists them all.

Anyone who can see an app can receive its `app.published`, `release.created`, `release.promoted` and `release.withdrawn` events. Everything else is only for its authors.

Each event looks like this:

```json
{"seq":42,"id":"7d0c…","type":"release.promoted","app_id":"briefcase","actor_uuid":"8HV…","occurred_at":"2026-10-09T10:15:00Z","data":{"id":"…","channel":"production","version":"1.4.0","package_ids":["…"]}}
```

`seq` is the event's place in the log, and you use it to resume.

## Filter by type

Add `types` with exact types, a group, or everything: `?types=release.promoted,package.*` or `?types=*`. An unknown type gets a 400 `unknown_event_type` that lists the known ones.

## Stream with server-sent events

```sh
curl -N -H "Authorization: Bearer $APPS_TOKEN" \
  "https://apps.teamofsilicons.com/v1/apps/ring/events/stream?types=package.*,release.*"
```

```text
retry: 3000
: ready cursor=41

id: 42
event: package.validation_step
data: {"seq":42,"type":"package.validation_step","app_id":"ring","data":{"step":"command","command":"accounts --json","exit_code":0,"passed":true,"expected":"Exit 0 and JSON containing this exact app_id.","stdout":"{\"app_id\":\"ring\"}","stderr":""}}

: heartbeat
```

- Without `Last-Event-ID` the stream starts at the newest event. Send `Last-Event-ID: 41` (or `?last_event_id=41`) to get everything after event 41. Browsers do this for you when they reconnect.
- A `: heartbeat` comment arrives every 15 seconds, so you can tell a quiet stream from a dead one.
- A stream ends after 30 minutes. Reconnect with the last `id` you saw and you miss nothing.
- One client can hold 10 streams open, and a single stream with `?types=` can follow several kinds of events.

Watching an upload is the most common use. Open the app's stream, upload, and you see the archive check, the manifest check and each of the three commands with its exit code and output, as the runner finishes each one.

```sh
silicon-apps events --app ring --type 'package.*' --follow
silicon-apps events --type release.promoted
```

`--follow` prints one JSON line per event. Without it you get one page, and `--after SEQ` gets you the next.

## Subscribe

A subscription follows one app you can see, or your own account feed. It delivers to a webhook, or to a stream that keeps your place.

```sh
silicon-apps subscriptions create --app briefcase --type release.promoted \
  --webhook https://example.com/hooks/apps
```

```http
POST /v1/subscriptions
Authorization: Bearer …
Idempotency-Key: follow-briefcase-1

{"app_id":"briefcase","types":["release.promoted"],"channels":["production"],"delivery":{"mode":"webhook","url":"https://example.com/hooks/apps"},"description":"Tell me when briefcase ships"}
```

The answer has the subscription and, for a webhook, its signing secret: `whsec_` followed by base64. You see the secret only once, so save it now. If you lose it, `silicon-apps subscriptions rotate-secret ID` makes a new one, and the old one stops working at once.

- `types` defaults to everything you can see in that feed. If you follow an app you don't author, you can only choose its public types.
- `channels` limits release events to `production` or `development`. Leave it out to get both.
- `{"mode":"stream"}` needs no URL. Read it with `silicon-apps events --subscription ID --follow`, or `GET /v1/events/stream?subscription=ID`. Without `Last-Event-ID` it continues where you last stopped.
- Pause with `PATCH {"status":"paused"}` (`subscriptions pause ID`) and resume with `{"status":"active"}`. Deliveries that come due while it's paused wait, and go out when you resume if that's within 72 hours of their event.
- `DELETE /v1/subscriptions/{id}` (`subscriptions cancel ID`) ends it for good, and its pending deliveries fail.
- An account can have 50 active or paused subscriptions. Every create, update and cancel takes an `Idempotency-Key`.

## Webhook deliveries

Each delivery is a `POST` of the event as JSON:

```http
POST /hooks/apps HTTP/1.1
content-type: application/json
user-agent: SiliconApps-Webhooks/1
x-apps-event-id: 7d0c…
x-apps-event-type: release.promoted
x-apps-delivery-id: dlv_…
x-apps-subscription-id: sub_…
x-apps-timestamp: 1791540900
x-apps-signature: v1=5f1c…

{"actor_uuid":"8HV…","app_id":"briefcase","data":{…},"event_id":"7d0c…","occurred_at":"2026-10-09T10:15:00Z","seq":42,"subscription_id":"sub_…","type":"release.promoted"}
```

We follow the same rules as [Silicon Accounts webhooks](/docs/accounts/learn/webhooks):

- `X-Apps-Signature` is `v1=` followed by the hex HMAC-SHA256 of `"{X-Apps-Timestamp}.{raw body}"`, keyed with the whole `whsec_` secret. It may list several `v1=` values separated by commas. Accept the delivery when any one of them matches.
- Check the bytes you received, not JSON you parsed and wrote out again. Refuse timestamps more than 5 minutes away from your clock.
- Skip an `event_id` you already handled, because a retry carries the same one.
- Answer with any 2xx within 10 seconds. Anything else, a timeout or a redirect (we don't follow redirects) is a failed attempt. We retry after 10 s, 30 s, 1 min, 5 min, 15 min and 30 min, then every hour, for 72 hours after the event.
- In production, deliveries go only to `https` URLs on public addresses.

Check a delivery in Rust with the client:

```rust
use silicon_apps_client::events::verify_webhook;

fn accept(secret: &str, timestamp: &str, signature: &str, body: &[u8]) -> anyhow::Result<()> {
    verify_webhook(secret, timestamp, signature, body, chrono::Utc::now().timestamp(), 300)
}
```

In any other language it's a few lines. Here it is in Python:

```python
import hashlib, hmac, time

def accept(secret: str, timestamp: str, signature: str, body: bytes) -> bool:
    if abs(time.time() - int(timestamp)) > 300:
        return False
    expected = hmac.new(secret.encode(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(part.strip()[3:], expected)
               for part in signature.split(",") if part.strip().startswith("v1="))
```

`silicon-apps subscriptions ping ID` sends a signed `ping` so you can test your receiver. `silicon-apps subscriptions deliveries ID` lists recent deliveries with their attempts and the exact last error.
