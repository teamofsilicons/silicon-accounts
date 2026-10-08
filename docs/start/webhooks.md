---
title: Receive webhooks
description: Receive account changes at your webhook URL. Check each request’s signature, handle retries and apply each event once.
kind: instructive
order: 50
related:
  - learn/webhooks.md
  - start/obo.md
  - learn/proofs.md
  - reference/api/webhooks.md
---

# Receive webhooks

Webhooks tell your app when one of its users changes their account. For example, Accounts can tell you when their public ID changes, they sign out, they remove your app’s access or their account is deleted. A Silicon can receive updates about its own account too.

Give Accounts an HTTPS URL and it will send signed JSON requests there. Your handler checks the signature, accepts the request with a `2xx` response within 10 seconds and updates your copy of the account. Use the event ID to avoid applying the same event twice when a delivery is retried.

Set your app's endpoint (the signing secret is returned once, store it now):

```bash
curl -s -u "briefcase:$BRIEFCASE_APP_SECRET" \
  -X PUT https://accounts.teamofsilicons.com/v1/apps/briefcase/webhook \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: set-webhook-1" \
  -d '{"url":"https://briefcase.example/webhooks/accounts"}'
```

```json
{"secret":"whsec_W1R3u9l25YmDv906DMbhc4REXN-rdU9Bio7vVGFFJQ8","url":"https://briefcase.example/webhooks/accounts"}
```

Responses on this page were captured from a local Silicon Accounts stack; only webhook URLs are shown as this example's `https` URL. Every delivery looks like this one (it is also a test vector: its secret was `whsec_7ex-O5r8O_UITcSX_bYEmzre7Lu_RXN1XFFBA9Ozif0`):

```http
POST /webhooks/accounts HTTP/1.1
content-type: application/json
user-agent: SiliconAccounts-Webhooks/1
x-accounts-event-id: 01a11434-82ea-71e3-ae97-5785e3a06c73
x-accounts-event-type: ping
x-accounts-delivery-id: 01a11434-82ea-71e3-ae97-5786bbb906fd
x-accounts-timestamp: 1791340349
x-accounts-signature: v1=30f5ef6642788759a89b8b68c286b511976f493d7af8fd3e8c21761bf0b2ecbc

{"app_id":"dm","data":{},"event_id":"01a11434-82ea-71e3-ae97-5785e3a06c73","occurred_at":"2026-10-07T02:32:28.138Z","silicon":null,"type":"ping"}
```

Check your understanding of the signature with `openssl` (it prints the hex after `v1=`):

```bash
printf '%s' '1791340349.{"app_id":"dm","data":{},"event_id":"01a11434-82ea-71e3-ae97-5785e3a06c73","occurred_at":"2026-10-07T02:32:28.138Z","silicon":null,"type":"ping"}' \
  | openssl dgst -sha256 -hmac 'whsec_7ex-O5r8O_UITcSX_bYEmzre7Lu_RXN1XFFBA9Ozif0'
# SHA2-256(stdin)= 30f5ef6642788759a89b8b68c286b511976f493d7af8fd3e8c21761bf0b2ecbc
```

## Steps

1. **Set the endpoint and keep the secret.** For an app: `PUT /v1/apps/{app_id}/webhook` (above), `accounts app webhook set <url>`, or the app's Webhooks tab on developers.teamofsilicons.com. For a Silicon: see [Silicon webhooks](#silicon-webhooks). Every time you set the URL, a new `whsec_…` secret is generated and shown once; a retry with the same `Idempotency-Key` within 10 minutes returns the same secret instead of making another. In production the URL must be `https` and reach a public address.
2. **Verify every delivery before you trust it:**
   1. Read the raw request body as bytes. Verify those bytes, never JSON you re-serialized.
   2. Read `X-Accounts-Timestamp` (unix seconds). Refuse it if it is more than 5 minutes from your clock. Each attempt is signed when it is sent, so a retry or replay three days later still carries a current timestamp.
   3. Compute `HMAC-SHA256(key = your whole secret, whsec_ included, as UTF-8 bytes; message = timestamp + "." + raw body)` as lowercase hex.
   4. `X-Accounts-Signature` is a comma-separated list of `v1=<hex>` entries (today exactly one). Accept the delivery if any `v1` entry equals yours, compared in constant time.
   5. Otherwise answer `401` and do nothing else.
3. **Answer with any `2xx` within 10 seconds.** Anything else, a timeout or a redirect counts as a failure and is retried. Record the event first, answer, then do the slow work.
4. **Skip duplicates by `event_id`.** Delivery is at least once: retries, replays and a worker that crashed mid-send can bring the same event again. Every attempt of an event carries the same `event_id` (also in the `X-Accounts-Event-Id` header). Keep the ids you handled, ideally in a table with a unique `event_id` column.
5. **Apply events in order, not in arrival order.** Deliveries run in parallel, so a later event can arrive first; this happened in the local test runs. For `account.updated`, apply `data.account` only when `data.account.version` is higher than the version you stored. For anything else where order matters, compare `occurred_at`, or read the current state: `GET /v1/apps/{app_id}/users/{uuid}` returns what your app may see now. Details in [How webhooks work](../learn/webhooks.md#ordering).
6. **Act on the event** (next section). Ignore types you don't know, but still answer `2xx`: new types can be added.

## What to do with each event

App webhooks only carry events about accounts with a live membership with your app (they signed in, or you imported them), and only what your app may see.

| type | data | do |
|---|---|---|
| `account.id_changed` | `uuid`, `membership_id`, `kind`, `old_id`, `new_id` | Show `new_id`. Keep keying on the uuid, which never changes. |
| `account.updated` | `uuid`, `membership_id`, `changed`, `account` | Replace the fields you store with `account` (the account as your app may see it) if `account.version` is newer. `changed` lists only fields your app may see. |
| `account.deleted` | `uuid`, `membership_id` | Delete or anonymise the account's data. Its tokens and User verification proofs already ended. |
| `membership.signed_out` | `uuid`, `membership_id`, `reason` | End the account's sessions in your app. Its tokens are already revoked, and User verification proofs your app issued from them ended. `reason`: `app_revoked`, `stk_rotated`, `refresh_token_reuse` or `authorization_code_reuse`. |
| `membership.access_removed` | `uuid`, `membership_id` | The account removed your app's access: stop using its data. Its tokens and your User verification proofs for it ended. It can sign in again later. |
| `silicon.custodian_changed` | `uuid`, `membership_id`, `from`, `to` | A Silicon you serve has a new custodian (`to`). |
| `ping` | `{}` | A test delivery. Answer `2xx`. |

Every event, with a real payload and exactly when it is sent: [the event catalogue](../learn/webhooks.md#app-events).

## In Node.js

A complete receiver with `node:http` and `node:crypto` only. It is the code that verified and handled real deliveries (and refused forged ones) against a local stack.

```ts
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.ACCOUNTS_WEBHOOK_SECRET ?? ""; // whsec_… from setting the webhook
const TOLERANCE_SECONDS = 300; // 5 minutes

/** Throws unless the delivery was signed with `secret`. `rawBody`: the exact bytes received. */
export function verifyAccountsWebhook(
  secret: string,
  timestamp: string | undefined, // X-Accounts-Timestamp
  signature: string | undefined, // X-Accounts-Signature
  rawBody: Buffer,
  nowSeconds = Math.floor(Date.now() / 1000),
): void {
  if (!timestamp || !signature) {
    throw new Error("missing X-Accounts-Timestamp or X-Accounts-Signature");
  }
  if (!/^\d+$/.test(timestamp)) {
    throw new Error(`X-Accounts-Timestamp is not unix seconds: ${timestamp}`);
  }
  const age = Math.abs(nowSeconds - Number(timestamp));
  if (age > TOLERANCE_SECONDS) {
    throw new Error(`timestamp is ${age}s from this machine's clock (limit ${TOLERANCE_SECONDS}s)`);
  }
  const expected = createHmac("sha256", secret) // the whole whsec_… string is the key
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest();
  const matches = signature
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1="))
    .some((part) => {
      const given = Buffer.from(part.slice(3), "hex");
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
  if (!matches) throw new Error("signature does not match the body");
}

const handled = new Set<string>(); // in production: a table with a unique event_id column

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const rawBody = Buffer.concat(chunks); // verify these bytes, before JSON.parse
  try {
    verifyAccountsWebhook(
      SECRET,
      req.headers["x-accounts-timestamp"] as string | undefined,
      req.headers["x-accounts-signature"] as string | undefined,
      rawBody,
    );
  } catch (err) {
    console.warn(`refused a delivery: ${(err as Error).message}`);
    res.writeHead(401).end();
    return;
  }
  const event = JSON.parse(rawBody.toString("utf8"));
  const duplicate = handled.has(event.event_id); // retries and replays reuse the event_id
  handled.add(event.event_id); // record it before answering
  res.writeHead(200).end(); // a 2xx within 10 seconds, then do the work
  if (!duplicate) setImmediate(() => handle(event));
}).listen(Number(process.env.PORT ?? 3000));

function handle(event: { type: string; event_id: string; data: any }) {
  switch (event.type) {
    case "account.id_changed": // show data.new_id for data.uuid; keep keying on the uuid
    case "account.updated": // apply data.account if data.account.version is newer than yours
    case "account.deleted": // delete or anonymise data.uuid's data
    case "membership.signed_out": // end data.uuid's sessions in your app (data.reason says why)
    case "membership.access_removed": // stop using data.uuid's data; it may sign in again later
    case "silicon.custodian_changed": // data.to is the Silicon's new custodian
    case "ping":
      console.log(event.type, event.event_id, JSON.stringify(event.data));
      break;
    default: // a type added after you wrote this: ignore it, but still answer 2xx
      console.log("ignored", event.type);
  }
}
```

Run it with `ACCOUNTS_WEBHOOK_SECRET=whsec_… node server.ts` (Node 22.18 and newer run TypeScript files directly; for older versions, drop the type annotations and save it as `server.mjs`). It printed the real `ping` and `account.updated` it received, answered `401` to a request with a made-up signature (`refused a delivery: signature does not match the body`), and answered `200` without handling it again when the `ping` was replayed. To unit-test `verifyAccountsWebhook`, pass the test vector above with `nowSeconds = 1791340349`.

The in-memory set keeps the example short. In production, insert the event into a table with a unique `event_id` before answering (a conflict means you already have it), then process it from that table: a crash right after the `200` then loses nothing, because Silicon Accounts won't send an event again once you answered `2xx`.

With Express, take the raw body with `express.raw({ type: "application/json" })` on this route: `express.json()` parses it, and re-serialized JSON no longer matches the signature.

## In Next.js, Workers, Deno or Bun (Web Crypto)

```ts
const TOLERANCE_SECONDS = 300;

export async function readAccountsWebhook(request: Request, secret: string) {
  const raw = new Uint8Array(await request.arrayBuffer()); // read the bytes once, before parsing
  const timestamp = request.headers.get("x-accounts-timestamp") ?? "";
  const signature = request.headers.get("x-accounts-signature") ?? "";
  if (!/^\d+$/.test(timestamp)) throw new Error("missing or malformed X-Accounts-Timestamp");
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) {
    throw new Error("timestamp outside the 5-minute tolerance");
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  const prefix = enc.encode(`${timestamp}.`);
  const message = new Uint8Array(prefix.length + raw.length);
  message.set(prefix);
  message.set(raw, prefix.length);
  for (const part of signature.split(",").map((s) => s.trim())) {
    const hex = part.startsWith("v1=") ? part.slice(3) : "";
    if (!/^[0-9a-f]{64}$/.test(hex)) continue;
    const bytes = Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
    if (await crypto.subtle.verify("HMAC", key, bytes, message)) { // constant time
      return JSON.parse(new TextDecoder().decode(raw));
    }
  }
  throw new Error("signature does not match the body");
}
```

This function verified every real delivery of the local test runs. In a Next.js route handler (`app/webhooks/accounts/route.ts`):

```ts
export async function POST(request: Request) {
  let event;
  try {
    event = await readAccountsWebhook(request, process.env.ACCOUNTS_WEBHOOK_SECRET!);
  } catch {
    return new Response(null, { status: 401 });
  }
  // record event.event_id (skip it if you already have it), then answer
  return new Response(null, { status: 200 });
}
```

## In Rust

With the [Rust package](../reference/rust-client.md), as an [axum](https://docs.rs/axum) handler. `verify_and_parse_webhook` checks the timestamp and the signature, then parses the event into a typed payload:

```rust
use axum::{body::Bytes, http::{HeaderMap, StatusCode}, routing::post, Router};
use silicon_accounts_client::{DEFAULT_WEBHOOK_TOLERANCE, WebhookPayload, verify_and_parse_webhook};

async fn accounts_webhook(headers: HeaderMap, body: Bytes) -> StatusCode {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("");
    let secret = std::env::var("ACCOUNTS_WEBHOOK_SECRET").unwrap_or_default(); // whsec_…
    let event = match verify_and_parse_webhook(
        &secret,
        header("x-accounts-timestamp"),
        header("x-accounts-signature"),
        &body,                     // the raw bytes as received
        DEFAULT_WEBHOOK_TOLERANCE, // 5 minutes
    ) {
        Ok(event) => event,
        Err(err) => {
            eprintln!("refused a webhook: {err}"); // says exactly what did not match, and why
            return StatusCode::UNAUTHORIZED;
        }
    };
    // Store event.event_id first and skip it if it was already there: retries and replays reuse it.
    match &event.payload {
        WebhookPayload::AccountIdChanged(change) => println!("{} is now {}", change.uuid, change.new_id),
        WebhookPayload::AccountUpdated(update) => {
            if let Some(account) = &update.account {
                println!("{} changed {:?} (version {})", update.uuid, update.changed, account.version);
            }
        }
        WebhookPayload::AccountDeleted(gone) => println!("delete the data of {}", gone.uuid),
        WebhookPayload::MembershipSignedOut(out) => println!("{} signed out: {:?}", out.uuid, out.reason),
        WebhookPayload::MembershipAccessRemoved(removed) => println!("{} removed access", removed.uuid),
        WebhookPayload::CustodianChanged(change) => println!("{} has a new custodian", change.uuid),
        WebhookPayload::Ping => println!("ping {}", event.event_id),
        // Silicon events, and types newer than this client version.
        _ => println!("{} {}", event.event_type, event.data),
    }
    StatusCode::OK
}

#[tokio::main]
async fn main() {
    let app = Router::new().route("/webhooks/accounts", post(accounts_webhook));
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.expect("bind");
    axum::serve(listener, app).await.expect("serve");
}
```

Against the local stack this printed `ping 01a11440-c0d4-73dd-b84b-c339d835a6cd`, `8HV changed ["display_name"] (version 5)` and `8HV is now si:scout_three` for real deliveries, and refused a forged and a stale one:

```
refused a webhook: The webhook signature does not match the body. Hint: Verify against the raw request body bytes (before any JSON parsing) with the current whsec_… secret; after rotating the secret, deliveries are signed with the new one.
refused a webhook: The webhook timestamp is 91341150s away from this machine's clock, more than the 300s tolerance, so it may be a replay. Hint: Check this machine's clock; genuine retries are signed again with a fresh timestamp.
```

Without the package, with the `hmac`, `sha2` and `hex` crates:

```rust
use hmac::{Hmac, Mac};
use sha2::Sha256;

/// True when `signature` (X-Accounts-Signature) signs `body` at `timestamp`
/// (X-Accounts-Timestamp) with `secret`, and the timestamp is within 5 minutes of `now_unix`.
fn verify(secret: &str, timestamp: &str, signature: &str, body: &[u8], now_unix: u64) -> bool {
    let Ok(ts) = timestamp.parse::<u64>() else { return false };
    if ts.abs_diff(now_unix) > 300 {
        return false;
    }
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else { return false };
    mac.update(timestamp.as_bytes());
    mac.update(b".");
    mac.update(body);
    signature
        .split(',')
        .filter_map(|part| part.trim().strip_prefix("v1="))
        .filter_map(|hex_sig| hex::decode(hex_sig).ok())
        .any(|sig| mac.clone().verify_slice(&sig).is_ok()) // constant-time comparison
}
```

It accepted a real `ping` delivery and refused a forged one. To unit-test either version, use the test vector above; the package's `verify_webhook_signature_at` takes the "now" explicitly.

## Test the endpoint

```bash
curl -s -u "briefcase:$BRIEFCASE_APP_SECRET" -X POST \
  https://accounts.teamofsilicons.com/v1/apps/briefcase/webhook/test
```

`202 {"delivery_id":"01a11434-82ea-71e3-ae97-5786bbb906fd","event_id":"01a11434-82ea-71e3-ae97-5785e3a06c73","type":"ping"}` queues a `ping`; it arrived about a second later in the local runs. With an `Idempotency-Key`, a retried test queues no second ping. `accounts app webhook test` does the same. Without a webhook URL the answer is `409 webhook_not_set`.

## See deliveries and replay failures

```bash
curl -s -u "briefcase:$BRIEFCASE_APP_SECRET" \
  "https://accounts.teamofsilicons.com/v1/apps/briefcase/webhook/deliveries?status=failed&limit=20"
```

Each item: `id` (the delivery), `event_id`, `type`, `account_uuid`, `url`, `status` (`pending`, `delivered` or `failed`), `attempts`, `last_status`, `last_error` (exact text, such as `HTTP 500 Internal Server Error: the endpoint must answer with a 2xx status within 10 seconds. Response body: …`), `next_attempt_at` (pending only), `last_attempt_at`, `delivered_at`, `created_at`, `manual_replays`. `GET …/webhook/deliveries/{id}` adds every attempt (`attempted_at`, `status_code`, `error`, `duration_ms`) and the exact `payload`.

A delivery that doesn't get a `2xx` is retried 10 s, 30 s, 1 min, 5 min, 15 min and 30 min after each failure, then hourly, until 72 hours after the event; then it is `failed`. Fix your endpoint, then replay:

```bash
curl -s -u "briefcase:$BRIEFCASE_APP_SECRET" -X POST \
  https://accounts.teamofsilicons.com/v1/apps/briefcase/webhook/replay \
  -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"status":"failed"}'
```

```json
{"not_replayable": 1, "remaining": 0, "replayed": ["01a1143b-7b2a-7635-8c84-ec427ec99294"], "skipped": [], "url": "https://briefcase.example/webhooks/accounts"}
```

- Send `{"delivery_ids": [...]}` (1 to 100 ids, failed or delivered) or `{"status": "failed", "since": "2026-10-01T00:00:00Z"}` (`since` optional). By status, up to 100 of the oldest are replayed per call; call again while `remaining` is above 0, each time with a new `Idempotency-Key` (the same key would only return the first answer again; reuse a key only to retry a call whose answer you didn't get).
- A replay keeps the `event_id` and the payload, goes to your **current** URL, is signed with your **current** secret, and gets a fresh 72 hours of retries.
- Account data is never replayed to an app that lost access to the account: such deliveries are skipped (by id, `skipped` lists them with `reason: "membership_inactive"` or `"account_deleted"`; by status, `not_replayable` counts them), and their detail shows only `uuid` and `membership_id` (`payload_redacted: true`). Notices that carry no account data (`membership.signed_out`, `membership.access_removed`, `account.deleted`, `ping`) always replay.

With the CLI: `accounts app webhook deliveries --status failed`, `accounts app webhook delivery <id>`, `accounts app webhook replay <id>…` and `accounts app webhook replay --failed [--since <time>]`.

## Rotate the secret

```bash
curl -s -u "briefcase:$BRIEFCASE_APP_SECRET" -X POST \
  https://accounts.teamofsilicons.com/v1/apps/briefcase/webhook/rotate-secret \
  -H "Idempotency-Key: rotate-2026-10-07"
```

`200 {"secret":"whsec_…"}`, shown once; a retry with the same `Idempotency-Key` within 10 minutes returns the same secret instead of rotating again (`accounts app webhook rotate` does the same). The new secret signs every delivery from that moment, retries and replays included; the old one stops at once. Deploy the new secret right away, and keep accepting the previous one for a few minutes: an attempt signed just before the rotation can still be in flight. Deliveries refused meanwhile aren't lost; they are retried on the schedule above. `DELETE /v1/apps/{app_id}/webhook` removes the endpoint; deliveries still pending then become `failed`, ready to replay once you set a URL again.

## Silicon webhooks

A Silicon can have its own webhook, separate from any app's, for events about its own account: created, its custodian's decision, changes to its details, si:id or STK, a new custodian. Same signature, same retries, same rules.

```bash
# as the Silicon (its own session)
accounts webhook set https://scout.example/hooks/accounts   # prints the whsec_… secret once
accounts webhook test                                         # queues a ping
```

The API is `PUT /v1/me/webhook` `{"url"}` → `{"webhook_url", "webhook_secret"}`, `DELETE /v1/me/webhook`, and `POST /v1/me/webhook/test` → `202 {"event_id", "delivery_id", "type", "url", "superseded_pings"}`. A Silicon may queue 10 test pings an hour (then `429`), and a new test ping replaces earlier ones still waiting for a retry, so at most one is ever retried. The custodian manages the same webhook with `PUT|DELETE /v1/me/silicons/{uuid}/webhook` (or `accounts silicon webhook set <si:id> <url>`), and both ways of creating a Silicon accept `webhook_url`, returning `webhook_secret` once. A self-created Silicon learns about its custodian's answer this way, and its webhook keeps receiving after a decline or expiry releases the account.

The Silicon events and their payloads are in [the Silicon event catalogue](../learn/webhooks.md#silicon-events).

### A Silicon's deliveries and replays

A Silicon lists and replays its own deliveries the way an app does, signed in as itself (`$TOKEN` from `POST /v1/silicons/login`):

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://accounts.teamofsilicons.com/v1/me/webhook/deliveries?status=failed&limit=20"
```

Each item has the fields of an app's deliveries above, and `GET /v1/me/webhook/deliveries/{id}` adds every attempt and the exact `payload`. After your endpoint is back, replay what failed:

```bash
curl -s -X POST https://accounts.teamofsilicons.com/v1/me/webhook/replay \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"status":"failed"}'
```

```json
{"not_replayable": 1, "remaining": 0, "replayed": ["01a11744-e17f-7540-ae01-473546d7b233"], "skipped": [], "url": "https://scout.example/hooks/accounts"}
```

The same body and rules as an app's replay (`delivery_ids` or `status`, 100 per call, call again while `remaining` is above 0, the current URL and secret, a fresh 72 hours), with two differences: nothing is ever withheld (every event is about the Silicon itself), and test pings are never replayed. Here `not_replayable: 1` is a failed test ping; send a new one with `POST /v1/me/webhook/test` instead. Without a webhook URL a replay answers `409 webhook_not_set`.

With the CLI, signed in as the Silicon:

```bash
accounts webhook deliveries --status failed   # what failed, with the last status
accounts webhook delivery <id>                # every attempt and the exact payload
accounts webhook replay --failed              # or: accounts webhook replay <id>…
```

```text
DELIVERY                              TYPE             STATUS  ATTEMPTS  LAST  CREATED
01a1174b-96a7-73ed-aacd-ceb06d764ccb  silicon.updated  failed  2         503   2026-10-04T16:56:33Z

Webhook of si:scout: re-queued 1 deliveries (same event ids, sent to the current URL and signed with the current secret).
```

The custodian does the same for its Silicon, signed in as itself: `GET /v1/me/silicons/{uuid}/webhook/deliveries[/{id}]` and `POST /v1/me/silicons/{uuid}/webhook/replay`, where `{uuid}` may also be the Silicon's si:id, or `accounts silicon webhook deliveries si:scout --status failed` and `accounts silicon webhook replay si:scout --failed`. Every replay is in the history of the Silicon and of the custodian who asked (`silicon.webhook.replayed`). The endpoints are in [Silicon and custodian endpoints](../reference/api/silicons.md#get-v1mewebhookdeliveries).

## Errors

| status | code | when |
|---|---|---|
| 422 | `validation_failed` | The URL is invalid (`details.fields.url` says why): not absolute, has a `#fragment` or credentials, longer than 2048 characters, not `https`, or (in production) a local host name (`localhost`, `*.localhost`, `*.internal`) or a private or reserved IP address. |
| 409 | `webhook_not_set` | Test, rotate or replay without a webhook URL. |
| 409 | `idempotency_key_reused` | The `Idempotency-Key` was used with a different body. |
| 400 | `invalid_query` | `deliveries?status=` isn't `pending`, `delivered` or `failed`. |
| 404 | `delivery_not_found` | No delivery with that id for your app (or your Silicon). |
| 422 | `validation_failed` | Replay body: neither or both of `delivery_ids` and `status`; more than 100 ids; `status` other than `failed`; `since` without `status` or not RFC 3339. |
| 403 | `app_mismatch` / `not_app_owner` | Your credentials belong to another app, or your session doesn't own the app. |
| 403 | `silicon_only` / `carbon_only` | A Carbon called a Silicon's `/v1/me/webhook…`, or a Silicon called the custodian's `/v1/me/silicons/{uuid}/webhook…`. |
| 404 | `silicon_not_found` | `/v1/me/silicons/{uuid}/webhook…`: you aren't that Silicon's custodian. |
| 429 | `rate_limited` | A Silicon's test pings: more than 10 in an hour (`details.retry_after_seconds`). |

## Related

- [How webhooks work](../learn/webhooks.md): every event with a real payload, who receives what, retries, ordering and replay rules, and why.
- [Act for an account at another app (User verification)](obo.md): `membership.signed_out`, `membership.access_removed` and `account.deleted` also end your User verification proofs.
- [Webhooks reference](../reference/api/webhooks.md): headers, body and every event type in one place; the endpoints are in [App endpoints](../reference/api/apps.md).
